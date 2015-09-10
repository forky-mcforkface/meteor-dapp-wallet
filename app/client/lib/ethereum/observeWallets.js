
/**
Created radom 32 byte string

@method random32Bytes
*/
var random32Bytes = function() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return s4() + s4() + s4() + s4() +
    s4() + s4() + s4() + s4() + s4() + s4() + s4() + s4() +
    s4() + s4() + s4() + s4();
};

/**
Update the contract data, like dailyLimit and required signatures.

@method updateContractData
*/
updateContractData = function(newDocument){
    var contractInstance = contracts['ct_'+ newDocument._id];

    if(!contractInstance)
        return;

    contractInstance.m_dailyLimit(function(e, result){
        if(!e)
            Wallets.update(newDocument._id, {$set: {
                dailyLimit: result.toString(10)
            }});
    });
    contractInstance.m_required(function(e, result){
        if(!e)
            Wallets.update(newDocument._id, {$set: {
                requiredSignatures: result.toString(10)
            }});
    });

    // UPDATE THE DAILYLIMITSPENT
    if(newDocument.version >= 1) {
        contractInstance.m_spentToday(function(e, spent) {
            contractInstance.m_lastDay(function(e, lastDay) {
                if(!e && spent && _.isFinite(spent.toString(10))) {

                    var now = new Date();
                    var fullDaysSinceEpoch = Math.floor(now/8.64e7);

                    // update the daily limit, when its still the same day
                    Wallets.update(newDocument._id, {$set: {
                        dailyLimitSpent: (fullDaysSinceEpoch === lastDay.toNumber()) ? spent.toString(10) : '0'
                    }});
                }

            });
        });
    }

    // check for version
    if(_.isUndefined(newDocument.version) && newDocument.address) {
        contractInstance.version(function(e, version){
            if(!e && version.toString(10)) {
                // var sha3 = web3.sha3(code, true);

                // // find version
                // index = 0;
                // _.find(contractVersions, function(contract, i){
                //     if(contract.original === sha3 || contract.stub === sha3) {
                //         index = i;
                //         return true;
                //     } else
                //         return false;
                // });

                Wallets.update(newDocument._id, {$set: {
                    version: version.toNumber()
                }});
                newDocument.version = version.toNumber();
            }
        });
    }
};


/**
Update the pending confirmations with either adding or removing the owner.

It will check first if the incoming log is newer than the already stored data.

@method confirmOrRevoke
@param {Object} log
*/
confirmOrRevoke = function(contract, log){
    var confirmationId = Helpers.makeId('pc', log.args.operation);

    contract.hasConfirmed(log.args.operation, log.args.owner, function(e, res){
        var pendingConf = PendingConfirmations.findOne(confirmationId),
            setDocument = {$set:{
                from: log.address
            }};

        // remove the sending property
        if(pendingConf && pendingConf.sending === log.args.owner)
            setDocument['$unset'] = {sending: ''};

        Helpers.eventLogs('CHECK OPERATION: '+ log.args.operation +' owner: '+ log.args.owner, res);

        if(res){
            if(pendingConf)
                setDocument['$addToSet'] = {confirmedOwners: log.args.owner};
            else
                setDocument['$set'].confirmedOwners = [log.args.owner];
        } else {
            if(pendingConf)
                setDocument['$pull'] = {confirmedOwners: log.args.owner};
            else
                setDocument['$set'].confirmedOwners = [];
        }

        PendingConfirmations.upsert(confirmationId, setDocument);
    });

    // var confirmationId = Helpers.makeId('pc', log.args.operation),
    //     pendingConf = PendingConfirmations.findOne(confirmationId);

    // if(pendingConf &&
    //    (!pendingConf.lastActivityBlock || 
    //     log.blockNumber > pendingConf.lastActivityBlock ||
    //     (log.blockNumber === pendingConf.lastActivityBlock && log.transactionIndex > pendingConf.lastActivityTxIndex))) {
        
    //     var data = {$set:{
    //         from: log.address,
    //         lastActivityBlock: log.blockNumber,
    //         lastActivityTxIndex: log.transactionIndex
    //     }};

    //     // remove the sending property
    //     if(pendingConf.sending === log.args.owner)
    //         data['$unset'] = {sending: ''};

    //     if(type === 'confirm')
    //         data['$addToSet'] = {
    //             confirmedOwners: log.args.owner
    //         };
    //     else
    //         data['$pull'] = {
    //             confirmedOwners: log.args.owner
    //         };

    //     PendingConfirmations.update(confirmationId, data);

    // } else if(!pendingConf) {
    //     PendingConfirmations.insert({
    //         _id: confirmationId,
    //         confirmedOwners: [log.args.owner],
    //         from: log.address,
    //         lastActivityBlock: log.blockNumber,
    //         lastActivityTxIndex: log.transactionIndex
    //     });
    // }
};

/**
Creates filters for a wallet contract, to watch for deposits, pending confirmations, or contract creation events.

@method setupContractFilters
@param {Object} newDocument
@param {Boolean} checkFromCreationBlock
*/
setupContractFilters = function(newDocument, checkFromCreationBlock){
    var blockToCheckBack = (EthBlocks.latest.number || 0) - ethereumConfig.rollBackBy;
    
    if(checkFromCreationBlock || blockToCheckBack < 0)
        blockToCheckBack = newDocument.creationBlock;

    var contractInstance = contracts['ct_'+ newDocument._id];
    if(!contractInstance)
        return;

    if(!contractInstance.events)
        contractInstance.events = [];

    var events = contractInstance.events;

    // stop all running events
    _.each(contractInstance.events, function(event){
        event.stopWatching();
        contractInstance.events.shift();
    });

    // WATCH for the created event, to get the creation block
    if(newDocument.imported) {

        Helpers.eventLogs('Imported wallet: '+ newDocument.address +' checking for any log from block #'+ newDocument.creationBlock);
        var importFilter = web3.eth.filter({address: newDocument.address, fromBlock: newDocument.creationBlock, toBlock: 'latest'});
        var intervalId = setInterval(function(){

            if(!importFilter.filterId)
                return;

            clearInterval(intervalId);

            importFilter.get(function(error, logs) {
                if(!error) {

                    var creationBlock = EthBlocks.latest.number;


                    // get earliest block number of appeared log
                    if(logs.length !== 0) {
                        logs.forEach(function(log){
                            if(log.blockNumber < creationBlock)
                                creationBlock = log.blockNumber;
                        });
                    }

                    // add the address state
                    Wallets.update(newDocument._id, {$unset: {
                        imported: '',
                    }, $set: {
                        creationBlock: creationBlock - 100
                    }});
                    newDocument = Wallets.findOne(newDocument._id);


                    // update dailyLimit and requiredSignatures
                    updateContractData(newDocument);

                    // add contract filters
                    setupContractFilters(newDocument, true);
                }
            });
        }, 100);

    // CHECK if for the contract address
    } else if(!newDocument.address) {

        Helpers.eventLogs('Contract address not set, checking for contract receipt');
        web3.eth.getTransactionReceipt(newDocument.transactionHash, function(error, receipt) {
            if(!error && receipt) {
                web3.eth.getCode(receipt.contractAddress, function(error, code) {
                    Helpers.eventLogs('Contract created on '+ receipt.contractAddress);

                    if(!error && code.length > 2) {

                        // add the address state
                        Wallets.update(newDocument._id, {$set: {
                            creationBlock: receipt.blockNumber,
                            address: receipt.contractAddress
                        }});
                        newDocument = Wallets.findOne(newDocument._id);

                        // set address to the contract instance
                        contracts['ct_'+ newDocument._id].address = receipt.contractAddress;

                        // SETUP DAILY LIMIT
                        // if(newDocument.dailyLimit && newDocument.dailyLimit !== ethereumConfig.dailyLimitDefault)
                        //     contractInstance.setDailyLimit(newDocument.dailyLimit, {from: newDocument.owners[0], gas: 1000000});
                        // // set simple wallet daily limit 100 000 000 ether
                        // else
                        //     contractInstance.setDailyLimit(ethereumConfig.dailyLimitDefault, {from: newDocument.owners[0], gas: 1000000});


                        // // ADD OWNERS
                        // if(newDocument.owners.length > 1) {
                        //     _.each(newDocument.owners, function(owner){
                        //         if(newDocument.owners[0] !== owner) {
                        //             contractInstance.addOwner(owner, {from: newDocument.owners[0], gas: 1000000});
                        //             // remove owner, so that log can re-add it
                        //             Wallets.update(newDocument._id, {$pull: {
                        //                 owners: owner
                        //             }});
                        //         }
                        //     });
                        // }

                        // // ADD REQUIRED SIGNATURES
                        // if(newDocument.requiredSignatures && newDocument.requiredSignatures != 1) {
                        //     Tracker.afterFlush(function(){
                        //         contractInstance.changeRequirement(newDocument.requiredSignatures, {from: newDocument.owners[0], gas: 500000});
                        //     });
                        // }


                        // add contract filters
                        setupContractFilters(Wallets.findOne(newDocument._id));

                    } else {
                        Helpers.eventLogs('Contract created on '+ receipt.contractAddress + ', but didn\'t stored the code!');

                        // remove account, if something failed
                        Wallets.remove(newDocument._id);
                    }
                });
            }
        });

    // ADD FILTERS
    } else {

        // SETUP FILTERS
        Helpers.eventLogs('Checking Deposits and ConfirmationNeeded for '+ newDocument.address +' from block #', blockToCheckBack);


        // delete the last tx and pc until block -1000
        _.each(Transactions.find({_id: {$in: newDocument.transactions || []}, blockNumber: {$exists: true, $gt: blockToCheckBack}}).fetch(), function(tx){
            Transactions.remove(tx._id);
        });
        _.each(PendingConfirmations.find({from: newDocument.address, blockNumber: {$exists: true, $gt: blockToCheckBack}}).fetch(), function(pc){
            PendingConfirmations.remove(pc._id);
        });


        events.push(contractInstance.allEvents({fromBlock: blockToCheckBack, toBlock: 'latest'}, function(error, log){
            if(!error) {
                Helpers.eventLogs(log);

                if(log.event === 'Deposit') {
                    Helpers.eventLogs('Deposit for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args.value.toNumber());

                    addTransaction(log, log.args.from, newDocument.address, log.args.value.toString(10));
                }
                if(log.event === 'SingleTransact' || log.event === 'MultiTransact') {
                    Helpers.eventLogs(log.event +' for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args.value.toNumber());

                    addTransaction(log, newDocument.address, log.args.to, log.args.value.toString(10));
                }
                if(log.event === 'ConfirmationNeeded') {
                    Helpers.eventLogs('ConfirmationNeeded for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args.value.toNumber() +', Operation '+ log.args.operation);

                    var block = web3.eth.getBlock(log.blockNumber, true, function(err, block){

                        if(!err) {
                            var confirmationId = Helpers.makeId('pc', log.args.operation),
                                accounts = Wallets.find({$or: [{address: log.address}, {address: log.args.to}]}).fetch(),
                                pendingConf = PendingConfirmations.findOne(confirmationId),
                                depositTx;

                            // PREVENT SHOWING pending confirmations, of WATCH ONLY WALLETS
                            if(!(from = Wallets.findOne({address: log.address})) || !EthAccounts.findOne({address: {$in: from.owners}}))
                                return;

                            if(accounts[0] && accounts[0].transactions) {
                                var txs = _.flatten(_.pluck(accounts, 'transactions'));
                                depositTx = Transactions.findOne({_id: {$in: txs || []}, operation: log.args.operation});
                            }


                            // add pending confirmation,
                            // if not already present, OR transaction already went through
                            if(depositTx) {
                                PendingConfirmations.remove(confirmationId);
                            
                            } else {
                                PendingConfirmations.upsert(confirmationId, {$set: {
                                    confirmedOwners: pendingConf ? pendingConf.confirmedOwners : [],
                                    initiator: log.args.initiator,
                                    operation: log.args.operation,
                                    value: log.args.value.toString(10),
                                    to: log.args.to,
                                    from: newDocument.address,
                                    timestamp: block.timestamp,
                                    blockNumber: log.blockNumber,
                                    blockHash: log.blockHash,
                                    transactionHash: log.transactionHash,
                                    transactionIndex: log.transactionIndex,
                                }});


                                // remove pending transactions, as they now have to be approved
                                var extistingTxId = Helpers.makeId('tx', log.transactionHash);
                                Meteor.setTimeout(function() {
                                    Transactions.remove(extistingTxId);
                                }, 500);
                            }
                        }
                        
                    });
                }
                if(log.event === 'OwnerAdded') {
                    Helpers.eventLogs('OwnerAdded for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args);

                    // re-add owner from log
                    Wallets.update(newDocument._id, {$addToSet: {
                        owners: log.args.newOwner
                    }});
                }
                if(log.event === 'OwnerRemoved') {
                    Helpers.eventLogs('OwnerRemoved for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args);

                    // re-add owner from log
                    Wallets.update(newDocument._id, {$pull: {
                        owners: log.args.oldOwner
                    }});
                }
                if(log.event === 'RequirementChanged') {
                    Helpers.eventLogs('RequirementChanged for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args);
                }
                if(log.event === 'Confirmation') {
                    Helpers.eventLogs('Operation confirmation for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args);

                    // delay a little to prevent race conditions
                    confirmOrRevoke(contractInstance, log);
                }
                if(log.event === 'Revoke') {
                    Helpers.eventLogs('Operation revokation for '+ newDocument.address +' arrived in block: #'+ log.blockNumber, log.args);

                    // delay a little to prevent race conditions
                    confirmOrRevoke(contractInstance, log);
                }
            }
        }));

    }

};


/**
Observe accounts and setup filters

@method observeWallets
*/
observeWallets = function(){

    /**
    Checking for confirmations of created wallets.

    Will only check if the old document, has no address and its inside the confirmations still.

    @method checkWalletConfirmations
    @param {Object} newDocument
    @param {Object} oldDocument
    */
    var checkWalletConfirmations = function(newDocument, oldDocument){
        var confirmations = EthBlocks.latest.number - newDocument.creationBlock;

        if(newDocument.address && (!oldDocument || (oldDocument && !oldDocument.address)) && confirmations < ethereumConfig.requiredConfirmations) {
            var filter = web3.eth.filter('latest');
            filter.watch(function(e, blockHash){
                if(!e) {
                    var confirmations = EthBlocks.latest.number - newDocument.creationBlock;

                    if(confirmations < ethereumConfig.requiredConfirmations && confirmations > 0) {
                        Helpers.eventLogs('Checking wallet address '+ newDocument.address +' for code. Current confirmations: '+ confirmations);

                        // TODO make smarter?

                        // Check if the code is still at the contract address, if not remove the wallet
                        web3.eth.getCode(newDocument.address, function(e, code){
                            if(!e) {
                                if(code.length > 2) {
                                    updateContractData(newDocument);                                

                                // check for wallet data
                                } else {
                                    Wallets.remove(newDocument._id);
                                    filter.stopWatching();
                                }
                            }
                        });
                    } else if(confirmations > ethereumConfig.requiredConfirmations) {
                        filter.stopWatching();
                    }
                }
            });
        }
    };

    /**
    Observe Wallets, listen for new created accounts.

    @class Wallets.find({}).observe
    @constructor
    */
    Wallets.find({}).observe({
        /**
        This will observe the account creation, to send the contract creation transaction.

        @method added
        */
        added: function(newDocument) {

            // DEPLOYED NEW CONTRACT
            if(!newDocument.address) {

                // identifier already exisits, so just watch for created and don't re-deploy
                if(newDocument.transactionHash) {
                    contracts['ct_'+ newDocument._id] = WalletContract.at();

                    // remove account, if something is searching since more than 30 blocks
                    if(newDocument.creationBlock + 50 <= EthBlocks.latest.number)
                        Wallets.remove(newDocument._id);

                    setupContractFilters(newDocument);
                    return;
                }


                if(_.isEmpty(newDocument.owners))
                    return;

                // SAFETY

                // 1. check if stub code has a proper address
                if(newDocument.code.indexOf('cafecafecafecafecafecafecafecafecafecafe') !== -1) {
                    GlobalNotification.error({
                        content: TAPi18n.__('wallet.newWallet.error.stubHasNoOrigWalletAddress'),
                        closeable: false
                    });
                    Wallets.remove(newDocument._id);
                    return;
                }

                // 2. check if we ares still on the right chain, before creating a wallet
                Helpers.checkChain(function(e) {
                    if(e) {
                        Wallets.remove(newDocument._id);

                    } else {
                        WalletContract.new(newDocument.owners, newDocument.requiredSignatures, (newDocument.dailyLimit || ethereumConfig.dailyLimitDefault), {
                            from: newDocument.owners[0],
                            data: newDocument.code,
                            gas: 1000000,

                        }, function(error, contract){
                            if(!error) {

                                // TX HASH arrived
                                if(!contract.address) {

                                    // add transactionHash to account
                                    newDocument.transactionHash = contract.transactionHash;

                                    Wallets.update(newDocument._id, {$set: {
                                        transactionHash: contract.transactionHash
                                    }});

                                // CONTRACT DEPLOYED
                                } else {

                                    contracts['ct_'+ newDocument._id] = contract;
                                    delete newDocument.code;

                                    Helpers.eventLogs('Contract Address: ', contract.address);

                                    // add transactionHash to account
                                    newDocument.address = contract.address;

                                    Wallets.update(newDocument._id, {$set: {
                                        creationBlock: EthBlocks.latest.number - 1,
                                        address: contract.address
                                    }, $unset: {
                                        code: ''
                                    }});


                                    updateContractData(newDocument);

                                    setupContractFilters(newDocument);

                                    // Show backup note
                                    EthElements.Modal.question({
                                        text: new Spacebars.SafeString(TAPi18n.__('wallet.accounts.modal.backupWallet', 
                                            {address: contract.address})),
                                        ok: true
                                    },{
                                        closeable: false
                                    });
                                }
                                
                            } else {
                                GlobalNotification.error({
                                    content: error.message,
                                    duration: 8
                                });

                                // remove account, if something failed
                                Wallets.remove(newDocument._id);
                            }
                        });
                    }
                });



            // USE DEPLOYED CONTRACT
            } else {
                contracts['ct_'+ newDocument._id] = WalletContract.at(newDocument.address);

                // update balance on start
                web3.eth.getBalance(newDocument.address, function(err, res){
                    if(!err) {
                        Wallets.update(newDocument._id, {$set: {
                            balance: res.toString(10)
                        }});
                    }
                });

                // check if wallet is at address
                web3.eth.getCode(newDocument.address, function(e, code) {
                    if(code && code.length > 2){
                        Wallets.update(newDocument._id, {$unset: {
                            disabled: ''
                        }});
                    } else {
                        Wallets.update(newDocument._id, {$set: {
                            disabled: true
                        }});
                    }
                });

                updateContractData(newDocument);

                setupContractFilters(newDocument);

                checkWalletConfirmations(newDocument, {});
            }
        },
        /**
        Will check if the contract is still there and update the today spend if a new tx is added

        @method changed
        */
        changed: function(newDocument, oldDocument){
            checkWalletConfirmations(newDocument, oldDocument);
        },
        /**
        Stop filters, when accounts are removed

        @method removed
        */
        removed: function(newDocument){
            var contractInstance = contracts['ct_'+ newDocument._id];
            if(!contractInstance)
                return;

            if(!contractInstance.events)
                contractInstance.events = [];

            // stop all running events
            _.each(contractInstance.events, function(event){
                event.stopWatching();
                contractInstance.events.shift();
            });

            delete contracts['ct_'+ newDocument._id];

            // delete the all tx and pending conf
            _.each(Transactions.find({from: newDocument.address}).fetch(), function(tx){
                if(!Wallets.findOne({transactions: tx._id}) && !EthAccounts.findOne({transactions: tx._id}))
                    Transactions.remove(tx._id);
            });
            _.each(PendingConfirmations.find({from: newDocument.address}).fetch(), function(pc){
                PendingConfirmations.remove(pc._id);
            });
        }
    });

};