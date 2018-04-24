var sandboxHelper = require('../utils/sandbox.js');
var slots = require('../utils/slots.js');
var Router = require('../utils/router.js');
var PIFY = require('../utils/pify.js')
var gatewayLib = require('gateway-lib')

var modules, library, self, private = {}, shared = {};

private.version, private.osName, private.port;

const GatewayLogType = {
  IMPORT_ADDRESS: 1,
  DEPOSIT: 2,
  WITHDRAWAL: 3,
}

function loopAsyncFunc(asyncFunc, interval) {
  setImmediate(function next() {
    (async function () {
      try {
        await asyncFunc()
      } catch (e) {
        library.logger.error('Failed to run ' + asyncFunc.name, e)
      }
      setTimeout(next, interval)
    })()
  })
}

function Gateway(cb, scope) {
  library = scope;
  self = this;
  self.__private = private;

  setImmediate(cb, null, self);
}

Gateway.prototype.importAccounts = async function () {
  const GATEWAY = global.Config.gateway.name
  let lastImportAddressLog = await app.model.GatewayLog.findOne({
    condition: {
      gateway: GATEWAY,
      type: GatewayLogType.IMPORT_ADDRESS
    }
  })
  library.logger.debug('find last import address log', lastImportAddressLog)
  let lastSeq = 0
  if (lastImportAddressLog) {
    lastSeq = lastImportAddressLog.seq
  } else {
    await app.model.GatewayLog.create({ gateway: GATEWAY, type: GatewayLogType.IMPORT_ADDRESS, seq: 0 })
  }
  let gatewayAccounts = await app.model.GatewayAccount.findAll({
    condition: {
      gateway: GATEWAY,
      seq: {
        $gt: lastSeq
      },
    },
    sort: {
      seq: 1
    },
    limit: 100
  })
  library.logger.debug('find gateway account', gatewayAccounts)
  let len = gatewayAccounts.length
  if (len > 0) {
    for (let a of gatewayAccounts) {
      await PIFY(gatewayLib.bitcoin.importAddress)(a.outAddress)
    }
    lastSeq = gatewayAccounts[len - 1].seq
    await app.model.GatewayLog.update({ seq: lastSeq }, { gateway: GATEWAY, type: GatewayLogType.IMPORT_ADDRESS})
  }
}

Gateway.prototype.processDeposits = async function () {
  const GATEWAY = global.Config.gateway.name
  let cond = {
    gateway: GATEWAY,
    type: GatewayLogType.DEPOSIT
  }
  let lastDepositLog = await app.model.GatewayLog.findOne({ condition: cond })
  library.logger.debug('find gateway deposit log', lastDepositLog)
  let lastSeq = 0
  if (lastDepositLog) {
    lastSeq = lastDepositLog.seq
  } else {
    await app.model.GatewayLog.create({
      gateway: GATEWAY, type: GatewayLogType.DEPOSIT, seq: 0
    })
  }
  let ret = await PIFY(gatewayLib.bitcoin.getTransactionsFromBlockHeight)(lastSeq)
  if (!ret || !ret.transactions) {
    library.logger.error('Failed to get gateway transactions')
    return
  }
  let outTransactions = ret.transactions.filter((ot) => {
    return ot.category === 'receive'
  }).sort((l, r) => {
    return l.height - r.height
  })
  library.logger.debug('get gateway transactions', outTransactions)
  let len = outTransactions.length
  if (len > 0) {
    for (let ot of outTransactions) {
      let isAccountOpened = await app.model.GatewayAccount.exists({outAddress: ot.address})
      if (!isAccountOpened) {
        library.logger.warn('unknow address', {address: ot.address, gateway: GATEWAY, t: ot})
        continue
      }
      try {
        await PIFY(modules.transactions.addTransactionUnsigned)({
          type: 402,
          secret: global.Config.gateway.secret,
          fee: 10000000,
          args: [ot.address, GATEWAY, String(ot.amount * 100000000), ot.txid]
        })
        library.logger.info('submit gateway transaction', {address: ot.address, amount: ot.amount, gateway: GATEWAY})
      } catch (e) {
        library.logger.warn('Failed to submit gateway deposit', e)
      }
    }
    lastSeq = outTransactions[len - 1].height
    await app.model.GatewayLog.update({ seq: lastSeq }, cond)
  }
}

Gateway.prototype.processWithdrawals = async function () {
  let GATEWAY = global.Config.gateway.name
  let PAGE_SIZE = 25
  let validators = await app.model.GatewayMember.findAll({
    condition: {
      gateway: GATEWAY,
      elected: 1
    }
  })
  if (!validators) {
    library.logger.error('Validators not found')
    return
  }
  library.logger.debug('get gateway validators', validators)

  let outPublicKeys = validators.map((v) => v.outPublicKey ).sort((l, r) => l - r)
  let unlockNumber = Math.floor(outPublicKeys.length / 2) + 1
  let multiAccount = app.createMultisigAddress(GATEWAY, unlockNumber, outPublicKeys)
  library.logger.debug('gateway validators cold account', multiAccount)

  let cond = {
    gateway: GATEWAY,
    type: GatewayLogType.WITHDRAWAL 
  }
  let lastSeq = 0
  let lastWithdrawalLog = await app.model.GatewayLog.findOne({ condition: cond })
  library.logger.debug('find gateway withdrawal log', lastWithdrawalLog)
  if (lastDepositLog) {
    lastSeq = lastWithdrawalLog.seq
  } else {
    await app.model.GatewayLog.create({ gateway: GATEWAY, type: GatewayLogType.WITHDRAWAL, seq: 0 })
  }
  let withdrawals = await app.model.GatewayWithdrawals.findAll({
    condition: {
      gateway: GATEWAY,
      seq: { $gt: lastSeq - PAGE_SIZE}
    },
    limit: PAGE_SIZE * 2
  })
  library.logger.debug('get gateway withdrawals', withdrawals)
  if (!withdrawals || !withdrawals.length) {
    return
  }
  let account = {
    privateKey: global.Config.gateway.outSecret
  }
  for (let w of withdrawals) {
    try {
      if (!w.outTransaction) {
        let output = {
          address: w.recipientId,
          amount: w.amount
        }
        let ot = await PIFY(gatewaylib.bitcoin.createNewTransaction)(account, output)
        if (typeof ot !== 'string') ot = ot.toString('hex')

        let ots = gatewaylib.bitcoin.signTransaction(ot, account, multiAccount)
        if (typeof ots !== 'string') ots = ots.toString('hex')

        await PIFY(modules.transactions.addTransactionUnsigned)({
          type: 404,
          secret: global.Config.gateway.secret,
          fee: 10000000,
          args: [w.tid, ot, ots]
        })
      } else {
        let ots = gatewaylib.bitcoin.signTransaction(w.outTransaction, account, multiAccount)
        await PIFY(modules.transactions.addTransactionUnsigned)({
          type: 405,
          secret: global.Config.gateway.secret,
          fee: 10000000,
          args: [w.tid, ots]
        })
      }
    } catch (e) {
      library.logger.error('process withdrawal error', e)
    }
  }
  let len = withdrawals.length
  await app.model.GatewayLog.update({ seq: withdrawals[len-1].seq }, cond)
}

Gateway.prototype.onBlockchainReady = function () {
  if (global.Config.gateway) {
    loopAsyncFunc(self.importAccounts.bind(self), 10 * 1000)
    loopAsyncFunc(self.processDeposits.bind(self), 10 * 1000)
    loopAsyncFunc(self.processWithdrawals.bind(self), 10 * 1000)
  }
}

Gateway.prototype.onBind = function (scope) {
  modules = scope;
}

module.exports = Gateway;