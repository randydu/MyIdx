'use strict'

/**
 * Data Access Layer
 */

const DB_VERSION_V1 = 1; //int32-indexed "coins" & "payloads" collections
const DB_VERSION_V2 = 2; //int64-indexed "coins" & "payloads" collections
/**
 * V3: reorganize collections as following:
 * 
 * (1) coins/coins_multisig/coins_noaddress: uxto on blockchain 
 * (2) pending_coins/pending_coins_multisig/pending_coins: uxto in mempool backup_spent_coins: uxtos spent by recent might-be-rolled-back blocks 
 * (3) backup_blocks: recent might-be-rolled-back blocks 
 * (4) log: event logs 
 * (5) summary: generic info
 */
const DB_VERSION_V3 = 3; 
const LATEST_DB_VERSION = DB_VERSION_V3;

const LOG_LEVEL_TRACE = 0;
const LOG_LEVEL_INFO = 1;
const LOG_LEVEL_WARN = 2;
const LOG_LEVEL_ERROR = 3;
const LOG_LEVEL_FATAL = 4;

const BigNumber = require('bignumber.js');
const common = require('./common');
const debug = require('mydbg')('dal');

const config = common.config;
const support_payload = config.coin_traits.payload;
const support_multisig = config.coin_traits.MULTISIG;
const resolve_spending = config.resolve_spending;

const Long = require('mongodb').Long;
const LONG_ONE = Long.fromInt(1);

const MongoClient = require('mongodb').MongoClient;
var client = null;
var database = null; 

var stopping = false; //user stop


async function setLastValue(key, v){
    await database.collection("summary").findOneAndUpdate(
        { _id: key }, 
        {$set: {value: v}},
        { upsert: true }
    );
}

async function getLastValue(key){
    let r = await database.collection("summary").findOne({ _id: key });
    return r == null ? null : r.value;
}

async function deleteLastValue(key){
    await database.collection('summary').deleteOne({_id: key});
}

/* deprecated. (DB_VERSION_V1)
async function getNextCoinIdInt32(){
    let r = await database.collection("coins").find().sort({_id: -1}).limit(1).next();
    return r == null ? 1 : r._id + 1;
}
*/
async function getNextCoinIdLong(){
    let r = await database.collection("coins").find().sort({_id: -1}).limit(1).next();
    return r == null ? LONG_ONE : Long.fromNumber(r._id).add(LONG_ONE);
}

async function getNextMultiSigCoinId(){
    let r = await database.collection("coins_multisig").find().sort({_id: -1}).limit(1).next();
    return r == null ? 1 : r._id + 1;
}

async function getNextNoAddrCoinIdLong(){
    let r = await database.collection("coins_noaddr").find().sort({_id: -1}).limit(1).next();
    return r == null ? LONG_ONE : Long.fromNumber(r._id).add(LONG_ONE);
}

async function getNextPayloadIdLong(){
    let r = await database.collection("payloads").find().sort({_id: -1}).limit(1).next();
    return r == null ? LONG_ONE : Long.fromNumber(r._id).add(LONG_ONE);
}


module.exports = {
    LOG_LEVEL_TRACE,
    LOG_LEVEL_INFO,
    LOG_LEVEL_WARN,
    LOG_LEVEL_ERROR,
    LOG_LEVEL_FATAL,

    async init(do_upgrade = false){
        debug.info("dal.init >>");

        let mongodb_url = process.env.MONGODB_URL;
        debug.info("MONGODB_URL=%s", mongodb_url);
        
        client = await MongoClient.connect(mongodb_url, { useNewUrlParser: true });
        if(!client.isConnected()){
            debug.throw_error("database not connected!");
        }

        database = client.db('myidx');

        if(!do_upgrade){
            let lastBlockInfo = await this.getLastRecordedBlockInfo();
            if(lastBlockInfo != null ){
                let ver = await this.getDBVersion();
                if(ver != LATEST_DB_VERSION){
                    //database version mismatch
                    debug.throw_error(`Database version mismatch, the version expected: [${LATEST_DB_VERSION}] db_version: [${ver}], need to run upgrade once!`);
                }
            }

            await Promise.all([
                database.createCollection("coins"),
                support_multisig ? database.createCollection("coins_multisig") : Promise.resolve(),
                database.createCollection('coins_noaddr'),


                database.createCollection("pending_coins"),
                support_multisig ? database.createCollection("pending_coins_multisig") : Promise.resolve(),
                database.createCollection("pending_coins_noaddr"),

                resolve_spending ? database.createCollection("pending_spents") : Promise.resolve(),
                resolve_spending && support_multisig? database.createCollection("pending_spents_multisig") : Promise.resolve(),
                resolve_spending ? database.createCollection("pending_spents_noaddr"): Promise.resolve(),
                resolve_spending ? Promise.resolve() : database.createCollection("pending_spents_bare"),

                support_payload ? database.createCollection("payloads") : Promise.resolve(),
                support_payload ? database.createCollection("pending_payloads") : Promise.resolve(),
                
                database.createCollection("rejects"),
                database.createCollection('backup_blocks'),
                database.createCollection('backup_spent_coins'),
                database.createCollection('logs'),
                database.createCollection('summary'),
            ]);

            await Promise.all([
                database.collection('coins').createIndexes([
                    { key: {address: 1}, name: "idx_addr" }, 
                    { key: {height: 1}, name: "idx_height" }, 
                    { key: {tx_id: 1, pos: 1}, name: "idx_xo", unique: config.coin_traits.BIP34 },//multiple (tx_id,pos) in coinbase pre-BIP34
                ]), 

                support_multisig ? database.collection('coins_multisig').createIndexes([
                    { key: {addresses: 1}, name: "idx_addr" }, 
                    { key: {height: 1}, name: "idx_height" }, 
                    { key: {tx_id: 1, pos: 1}, name: "idx_xo", unique: true }, //multisig cannot appear in coinbase, so it should be unique
                ]) : Promise.resolve(), 

                database.collection('coins_noaddr').createIndexes([
                    { key: {height: 1}, name: "idx_height" }, 
                    { key: {tx_id: 1, pos: 1}, name: "idx_xo", unique: true }, //multisig cannot appear in coinbase, so it should be unique
                ]),

                support_payload ? database.collection('payloads').createIndexes([
                    { key: { address: 1, hint: 1, subhint:1 }, name: "idx_addr_hint" }, 
                    { key: {height: 1}, name: "idx_height" }, 
                    { key: {tx_id: 1, pos: 1}, name: "idx_xo", unique: true },
                ]) : Promise.resolve(),

                resolve_spending ? database.collection('pending_spents').createIndexes([
                    { key: { address: 1 }, name: "idx_addr" }, 
                    { key: {height: 1}, name: "idx_height" }, 
                    { key: {tx_id: 1}, name: "idx_tx" } 
                ]): Promise.resolve(),
                resolve_spending && support_multisig? database.collection('pending_spents_multisig').createIndexes([
                    { key: { addresses: 1 }, name: "idx_addr" }, 
                    { key: {height: 1}, name: "idx_height" }, 
                    { key: {tx_id: 1}, name: "idx_tx" } 
                ]): Promise.resolve(),
                resolve_spending ? database.collection('pending_spents_noaddr').createIndexes([
                    { key: {height: 1}, name: "idx_height" }, 
                    { key: {tx_id: 1}, name: "idx_tx" } 
                ]): Promise.resolve(),

                resolve_spending ? Promise.resolve() : database.collection('pending_spents_bare').createIndexes([
                    { key: {spent_tx_id: 1, pos: 1}, name: "idx_spent_tx_pos" }, 
                    { key: {tx_id: 1}, name: "idx_tx" }
                ]),


                database.collection('pending_coins').createIndexes([
                    { key: { address: 1 }, name: "idx_addr" }, 
                    { key: {tx_id: 1}, name: "idx_tx" } 
                ]),
                database.collection('pending_coins_noaddr').createIndexes([
                    { key: {tx_id: 1}, name: "idx_tx"}, 
                ]),
                
                support_multisig ?
                    database.collection('pending_coins_multisig').createIndexes([
                        { key: { addresses: 1 }, name: "idx_addr" }, 
                        { key: {tx_id: 1}, name: "idx_tx" } 
                    ]) : Promise.resolve(),
                
                support_payload ? database.collection('pending_payloads').createIndexes([
                    { key: {address: 1}, name: "idx_addr" }, 
                    { key: {tx_id: 1}, name: "idx_tx"}
                ]): Promise.resolve(),

                database.collection('rejects').createIndexes([
                    { key: { tx_id: 1 }, name: "idx_tx", unique: true }
                ]),

                database.collection('logs').createIndexes([
                    { key: { level: 1 }, name: "idx_level", unique: false }
                ]),

                database.collection('backup_blocks').createIndexes([
                    { key: {hash: 1}, name: "idx_hash", unique: true },
                ]),
                database.collection('backup_spent_coins').createIndexes([
                    { key: {height: 1}, name: "idx_height", unique: false }, 
                    { key: {tx_id: 1, pos: 1}, name: "idx_xo", unique: true },
                ]),
            ]);

            await this.setDBVersion(LATEST_DB_VERSION);

            await this.setDBTraits({
                resolve_spending,
                support_multisig,
                support_payload,
            });
        }

        debug.info("dal.init <<");
    },

    stop(){
        stopping = true;
    },

    async close(){
        if(client && client.isConnected()) await client.close();
    },

    //The current db version supported.
    getLatestDBVersion(){
        return LATEST_DB_VERSION;
    },

    async getDBVersion(){
        let v = await getLastValue("db_version");
        return v == null ? 1 : v;
    },

    async setDBVersion(db_ver){
        await setLastValue("db_version", db_ver);
    },
    async setDBTraits(db_traits){
        await setLastValue("db_traits", db_traits);
    },

    async setCoinInfo(ci){
        let pre_ci = await getLastValue("coin");
        if(pre_ci == null){
            await setLastValue("coin", ci);
        }else{
            if(ci.coin != pre_ci.coin || ci.network != pre_ci.network){
                debug.throw_error("coin info mismatch!");
            }
        }
    },

    async getLastRecordedBlockInfo(){
        return await getLastValue('last_recorded_block');
    },
    async setLastRecordedBlockInfo(bi){
        await setLastValue('last_recorded_block', bi);
    },
    async getLastSafeBlockInfo(){
        return await getLastValue('last_safe_block');
    },
    async setLastSafeBlockInfo(bi){
        await setLastValue('last_safe_block', bi);
    },
    
    async getLastRecordedBlockHeight(){
        return await getLastValue('lastBlockHeight');
    },
    async setLastRecordedBlockHeight(height){
        await setLastValue('lastBlockHeight', height);
    },

    async addCoins(coins){
        if(coins.length > 0){
            let N = await getNextCoinIdLong();
            coins.forEach(x=> { x._id = N; N = N.add(LONG_ONE); });
            await database.collection("coins").insertMany(coins);
        }
    },
    async removeCoins(from_blk_no){
        await database.collection("coins").deleteMany({height: {$gte: from_blk_no}});
    },

    async addCoinsMultiSig(coins){
        if(coins.length > 0){
            let N = await getNextMultiSigCoinId();
            coins.forEach(x => x._id = N++);

            await database.collection("coins_multisig").insertMany(coins);
        }
    },
    async removeCoinsMultiSig(from_blk_no){
        await database.collection("coins_multisig").deleteMany({height: {$gte: from_blk_no}});
    },

    async addCoinsNoAddr(coins){
        if(coins.length > 0){
            let N = await getNextNoAddrCoinIdLong();
            coins.forEach(x=> { x._id = N; N = N.add(LONG_ONE); });
            await database.collection("coins_noaddr").insertMany(coins);
        }
    },
    async removeCoinsNoAddr(from_blk_no){
        await database.collection("coins_noaddr").deleteMany({height: {$gte: from_blk_no}});
    },

    async addPayloads(payloads){
        //let N = await database.collection("payloads").countDocuments({}) + 1;
        let N = await getNextPayloadIdLong();
        payloads.forEach(x => { x._id = N; N = N.add(LONG_ONE); });
        return database.collection("payloads").insertMany(payloads);
    },

    async removePayloads(from_blk_no){
        await database.collection("payloads").deleteMany({ height: {$gte: from_blk_no}});
    },

    async removeSpents(spents){
        if(spents.length > 0){
            let ops = spents.map(spent => {
                return {
                    deleteOne: { "filter": {"tx_id": spent.spent_tx_id, "pos": spent.pos}}
                }
            });
            let no_order = { ordered: false };

            await Promise.all([
                database.collection("coins").bulkWrite( ops, no_order),
                database.collection("coins_noaddr").bulkWrite( ops,no_order), 
                support_multisig ? database.collection("coins_multisig").bulkWrite( ops, no_order) : Promise.resolve(),
            ]);
        }

        /*
        return Promise.all(spents.map(spent => {
            //BIP34: the first coin (tx_id, pos) is spent. 
            //for non-BIP34 compatible coin, there could be multiple coins (tx_id, pos).
            //Ex: bitcoin (d5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599, 0) appears in
            //block #91842, #91812
            return database.collection("coins").deleteOne(
                { tx_id: spent.spent_tx_id, pos: spent.pos }
            );
        }));
        */
    },

    async backupSpents(spents){
        if(spents.length > 0){
            let coins = [];

            async function scanTable(collectionName, srcId){
                let table = database.collection(collectionName);
                if(table != null){
                    for(let i = 0; i < spents.length; i++){
                        let sp = spents[i];
                        let res = await table.findOneAndDelete({ tx_id: sp.spent_tx_id, pos: sp.pos });
                        if(res.ok && res.value != null){
                            coins.push({
                                //used by rollbackSpents
                                height: sp.height, 
                                src: srcId,
                                //used by check_rejection()
                                tx_id: sp.spent_tx_id, //== coin.tx_id
                                pos: sp.pos,  //== coin.pos

                                coin: res.value,
                            });
                        }
                    }
                }
            }

            await Promise.all([
                scanTable("coins", 0),
                support_multisig ? scanTable("coins_multisig", 1) : Promise.resolve(),
                scanTable("coins_noaddr", 2)
            ]);

            if(coins.length > 0){
                await database.collection("backup_spent_coins").insertMany(coins);
            }
        }
    },

    async rollbackSpents(from_blk_no){
        let coins = [];
        let coins_multisig = [];
        let coins_noaddr = [];

        let arrs = [coins, coins_multisig, coins_noaddr];
        
        let items = await database.collection("backup_spent_coins").find({height: {$gte: from_blk_no}}).toArray();
        if(items.length > 0){
            items.forEach(x => {
                arrs[x.src].push(x.coin);
            });

            await Promise.all([
                coins.length > 0 ? database.collection('coins').insertMany(coins) : Promise.resolve(),
                coins_multisig.length > 0 ? database.collection('coins_multisig').insertMany(coins_multisig) : Promise.resolve(),
                coins_noaddr.length > 0 ? database.collection('coins_noaddr').insertMany(coins_noaddr) : Promise.resolve(),

                database.collection("backup_spent_coins").deleteMany({height: {$gte: from_blk_no}}),
            ]);
        }
    },

    async retireBackupSpents(before_blk_no){
        await database.collection("backup_spent_coins").deleteMany({ height: {$lte: before_blk_no}});
    },

    async addPendingSpentBares(spents){
        if(spents.length > 0){
            await database.collection("pending_spents_bare").insertMany(spents);
        }
    },
    async addPendingSpents(spents){
        if(spents.length > 0){
            await database.collection("pending_spents").insertMany(spents);
        }
    },
    async addPendingSpentsMultiSig(spents){
        if(spents.length > 0){
            await database.collection("pending_spents_multisig").insertMany(spents);
        }
    },
    async addPendingSpentsNoAddr(spents){
        if(spents.length > 0){
            await database.collection("pending_spents_noaddr").insertMany(spents);
        }
    },
    async addPendingCoins(coins){
        if(coins.length > 0){
            await database.collection("pending_coins").insertMany(coins);
        }
    },
    async addPendingCoinsMultiSig(coins){
        if(coins.length > 0){
            await database.collection("pending_coins_multisig").insertMany(coins);
        }
    },
    async addPendingCoinsNoAddr(coins){
        if(coins.length > 0){
            await database.collection("pending_coins_noaddr").insertMany(coins);
        }
    },

    async addPendingPayloads(payloads){
        if(payloads.length > 0){
            await database.collection("pending_payloads").insertMany(payloads);
        }
    },

    async removeAllPendingTransactions(){
        return Promise.all([
            database.collection("pending_coins").remove({}),
            support_multisig ? database.collection("pending_coins_multisig").remove({}) : Promise.resolve(),
            database.collection("pending_coins_noaddr").remove({}),

            database.collection("pending_payloads").remove({}),

            resolve_spending ? database.collection("pending_spents").remove({}) : Promise.resolve(),
            resolve_spending && support_multisig ? database.collection("pending_spents_multisig").remove({}) : Promise.resolve(),
            resolve_spending ? database.collection("pending_spents_noaddr").remove({}) : Promise.resolve(),
            
            resolve_spending ? Promise.resolve() : database.collection("pending_spents_bare").remove({}),
        ]);
    },

    /**
     * Delete all pending info related to incoming txids
     * 
     * @param {txids} txids new parsed transaction-ids on blockchain
     */
    async removePendingTransactions(txids){
        let ops = txids.map(txid => {
            return {
                deleteMany: { "filter": { "tx_id":  txid }}
            }
        });

        return Promise.all([
            database.collection("pending_coins").bulkWrite(ops, { ordered: false} ), 
            support_multisig ? database.collection("pending_coins_multisig").bulkWrite(ops, { ordered: false} ) : Promise.resolve(),
            database.collection("pending_coins_noaddr").bulkWrite(ops, { ordered: false} ), 

            database.collection("pending_payloads").bulkWrite( ops, { ordered: false} ),

            resolve_spending ? database.collection("pending_spents").bulkWrite(ops, { ordered: false } ) : Promise.resolve(),
            resolve_spending && support_multisig ? database.collection("pending_spents_multisig").bulkWrite(ops, { ordered: false} ) : Promise.resolve(),
            resolve_spending ? database.collection("pending_spents_noaddr").bulkWrite(ops, { ordered: false} ) : Promise.resolve(),
            
            resolve_spending ? Promise.resolve() : database.collection("pending_spents_bare").bulkWrite(ops, { ordered: false} ),
        ]);
        
        /*
        return Promise.all(txids.map(txid => {
            let filter = { tx_id: { $eq: txid }};
            return Promise.all([
                database.collection("pending_coins").deleteMany(filter),
                database.collection("pending_payloads").deleteMany(filter),
                database.collection("pending_spents").deleteMany(filter)
            ]);
        }));
        */
    },

    async check_rejection(){
        let rejects = new Set();

        let collections = {
            coins: database.collection("coins"),
            coins_noaddr: database.collection("coins_noaddr"),
            coins_multisig: database.collection("coins_multisig"),
            pending_coins: database.collection("pending_coins"),
            pending_coins_noaddr: database.collection("pending_coins_noaddr"),
            pending_coins_multisig: database.collection("pending_coins_multisig"),
            backup_spent_coins: database.collection("backup_spent_coins"),
        }

        let stNow = Date.now()/1000;

        async function search_rejected_txs(collectionName){
            let spents = await database.collection(collectionName).find().toArray();
            if(spents.length > 0){
                for(let i = 0; i < spents.length; i++){
                    let sp = spents[i];
                    
                    let t = sp._id.getTimestamp().getTime()/1000;
                    if(stNow - t > config.min_pending_time){ //tx must be kept in pending queue for enough time period before it can be detected as rejected.
                        if(!rejects.has(sp.tx_id)){
                            async function coin_found(name){
                                if((name == "coins_multisig" || name == "pending_coins_multisig") && (!support_multisig)) return false;

                                return await collections[name].countDocuments({tx_id: sp.spent_tx_id, pos: sp.pos}) > 0;
                            }

                            if( !await coin_found("coins") &&
                                !await coin_found("coins_noaddr") &&
                                !await coin_found("coins_multisig") &&
                                !await coin_found("pending_coins") &&
                                !await coin_found("pending_coins_noaddr") &&
                                !await coin_found("pending_coins_multisig") &&
                                !await coin_found("backup_spent_coins") 
                            ){
                                //spent missing, must have been consumed by another transaction on blockchain!
                                rejects.add(sp.tx_id);
                            }
                        }
                    }
                }
            }
        }

        await search_rejected_txs("pending_spents");
        await search_rejected_txs("pending_spents_multisig");
        await search_rejected_txs("pending_spents_noaddr");

        if(rejects.size > 0){
            let txids = Array.from(rejects);
            let items = txids.map(x => {
                return {tx_id: x}
            });
            await Promise.all([
                database.collection("rejects").insertMany(items),
                this.removePendingTransactions(txids)
            ])

            rejects.clear();
        }
    },

    async addBackupBlocks(blks){
        await database.collection('backup_blocks').insertMany(blks);
    },

    //returns in height order
    async getBackupBlocks(){
        return await database.collection('backup_blocks').find({}).sort({_id: 1}).toArray();
    },

    async removeBackupBlocks(from_blk_no){
        await database.collection('backup_blocks').deleteMany({_id: {$gte: from_blk_no}});
    },
    async retireBackupBlocks(before_blk_no){
        await database.collection("backup_blocks").deleteMany({ _id: {$lte: before_blk_no}});
    },

    async logEvent(obj, code='', level= LOG_LEVEL_INFO){
        let pid = process.pid;
        let t = new Date().toISOString();

        function prepareItem(x){
            if(typeof x.code === 'undefined') x.code = code;
            if(typeof x.level === 'undefined') x.level = level;
            x.pid = pid;
            x.t = t;
        }
        if(Array.isArray(obj)){
            if(obj.length > 0){
                obj.forEach(prepareItem);
                await database.collection('logs').insertMany(obj);
            }
        }else {
            prepareItem(obj);
            await database.collection('logs').insertOne(obj);
        } 
    },

    async rollback(last_good_block){
        await this.rollbackSpents(last_good_block+1);
        await Promise.all([
            this.removeBackupBlocks(last_good_block+1),
            this.removePayloads(last_good_block+1),

            this.removeCoins(last_good_block+1),
            this.removeCoinsMultiSig(last_good_block+1),
            this.removeCoinsNoAddr(last_good_block+1),
        ]);
    },
    //-------------- V1 => V2 ---------------
    async upgradeV1toV2(debug){
        //check if coin_v1 already exists, in case we may pick up from previous incomplete upgrading.
        let has_coins_v1 = (await database.collections()).some(x => x.collectionName == 'coins_v1');

        if(!has_coins_v1){
            debug.info('fresh new upgrade...');
            await database.collection('coins').rename('coins_v1');
        }

        await database.createCollection("coins");
        await database.collection('coins').createIndexes([
            { key: {address: 1}, name: "idx_addr" }, 
            { key: {height: 1}, name: "idx_height" }, 
            { key: {tx_id: 1, pos: 1}, name: "idx_xo", unique: config.coin_traits.BIP34 },//multiple (tx_id,pos) in coinbase pre-BIP34
        ]);

        const last_upgrade_item = 'last_upgrade_item';

        debug.info('Counting total items to upgrade...');
        let tbCoinsV1 = database.collection('coins_v1');
        let N = await tbCoinsV1.countDocuments({});
        debug.info(`Total ${N} items to upgrade!`);

        if(N > 0){
            let tbCoins = database.collection('coins');

            let i = await getLastValue(last_upgrade_item);
            if(i != null){
                i++; //start of next batch
            }else{
                i = 0;
            } 
            if(i < N){
                debug.info(`delete all *dirty* items in target table from item[${i}]...`);
                let item = await tbCoinsV1.find().sort({_id:1}).skip(i).next();
                await tbCoins.deleteMany({_id: {$gte: Long.fromInt(item._id)}});
            }

            let j = i + config.batch_upgradeV1toV2;
            if(j > N) j = N;

            while(i < N) {
                if(stopping) break;

                debug.info(`upgrading [${i}, ${j})...`);

                let items = await tbCoinsV1.find().sort({_id: 1}).skip(i).limit(j-i).toArray();
                items.forEach(x => { x._id = Long.fromInt(x._id) });
                await tbCoins.insertMany(items);

                await setLastValue(last_upgrade_item,j-1);

                i = j;
                if( i < N){
                    j += config.batch_upgradeV1toV2;
                    if(j > N) j = N;
                }
            }

            let M = await getLastValue(last_upgrade_item);
            if( M == N-1){
                //debug.info("Upgrade Successfully! (FAKE)");
                //return; 
                //complete upgrade
                await tbCoinsV1.drop();
                await deleteLastValue(last_upgrade_item);
                await this.setDBVersion(LATEST_DB_VERSION);

                debug.info("V1=>V2 Upgrade Successfully!");
            }
        }
    },
    //-------------- V2 => V3 ---------------
    async upgradeV2toV3(debug){
        //errors => coins_noaddr
        await database.createCollection('coins_noaddr');
        await database.collection('coins_noaddr').createIndexes([
            { key: {height: 1}, name: "idx_height" }, 
            { key: {tx_id: 1, pos: 1}, name: "idx_xo", unique: true }, //multisig cannot appear in coinbase, so it should be unique
        ]);

        const last_upgrade_item = 'last_upgrade_item';

        debug.info('Counting total items to upgrade...');
        let tbErrors = database.collection('errors');
        let N = await tbErrors.countDocuments({});
        debug.info(`Total ${N} items to upgrade!`);

        let done = false;

        if(N > 0){
            const coin_traits = config.coin_traits;
            let tbCoins = database.collection('coins_noaddr');

            let i = await getLastValue(last_upgrade_item);
            if(i != null){
                i++; //start of next batch
            }else{
                i = 0;
            } 
            if(i < N){
                debug.info(`delete all *dirty* items in target table from item[${i}]...`);
                await tbCoins.deleteMany({_id: {$gte: Long.fromInt(i)}});
            }

            let j = i + config.batch_blocks;
            if(j > N) j = N;

            while(i < N) {
                if(stopping) break;

                debug.info(`upgrading [${i}, ${j})...`);

                let items = await tbErrors.find().sort({_id: 1}).skip(i).limit(j-i).toArray();

                await tbCoins.insertMany(items.filter(x => x.height >=0).map((x, k) => {
                    let out = x.tx_info.vout[x.pos];
                    let vCoin = new BigNumber(out.value); 
                    return {
                        _id: Long.fromInt(i + k),
                        tx_id: x.tx_id,
                        pos: x.pos,
                        value: vCoin.multipliedBy(coin_traits.SAT_PER_COIN).toString(),
                        height: x.height,
                        script: out.scriptPubKey
                    } 
                }));

                await setLastValue(last_upgrade_item,j-1);

                i = j;
                if( i < N){
                    j += config.batch_blocks;
                    if(j > N) j = N;
                }
            }

            let M = await getLastValue(last_upgrade_item);
            if( M == N-1){
                await tbErrors.drop();
                await deleteLastValue(last_upgrade_item);

                done = true;
            }
        }else{
            done = true;
        }

        if(done){
            //debug.info("Upgrade Successfully! (FAKE)");
            //return; 
            //complete upgrade
            await this.setDBVersion(LATEST_DB_VERSION);

            //Remove useless field
            let bi = await this.getLastRecordedBlockInfo();
            if(bi != null){
                await database.collection('summary').deleteOne({_id: 'lastBlockHeight'});
            }

            debug.info("V2=>V3 Upgrade Successfully!");
        }
    }
}