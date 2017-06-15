const amqp = require('amqplib/callback_api')
const chainpointProofSchema = require('chainpoint-proof-json-schema')
const async = require('async')
const uuidTime = require('uuid-time')
const chpBinary = require('chainpoint-binary')

// load all environment variables into env object
const env = require('./lib/parse-env.js')('gen')

const r = require('redis')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

/**
 * Opens a Redis connection
 *
 * @param {string} connectionString - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  redis = r.createClient(redisURI)
  redis.on('error', () => {
    redis.quit()
    redis = null
    console.error('Cannot connect to Redis. Attempting in 5 seconds...')
    setTimeout(openRedisConnection.bind(null, redisURI), 5 * 1000)
  })
  redis.on('ready', () => {
    console.log('Redis connected')
  })
}

/**
 * Convert Date to ISO8601 string, stripping milliseconds
 * '2017-03-19T23:24:32Z'
 *
 * @param {Date} date - The date to convert
 * @returns {string} An ISO8601 formatted time string
 */
function formatDateISO8601NoMs (date) {
  return date.toISOString().slice(0, 19) + 'Z'
}

function generateCALProof (msg) {
  let messageObj = JSON.parse(msg.content.toString())

  let proof = {}
  proof = addChainpointHeader(proof, messageObj.hash, messageObj.hash_id)
  proof = addCalendarBranch(proof, messageObj.agg_state, messageObj.cal_state)

  // ensure the proof is valid according to the defined Chainpoint v3 JSON schema
  let isValidSchema = chainpointProofSchema.validate(proof).valid
  if (!isValidSchema) {
    // This schema is not valid, ack the message but log an error and end processing
    // We are not nacking here because the poorly formatted proof would just be
    // re-qeueud and re-processed on and on forever
    amqpChannel.ack(msg)
    console.error(env.RMQ_WORK_IN_GEN_QUEUE, 'consume message acked, but with invalid JSON schema error')
    return
  }

  async.waterfall([
    // compress proof to binary format Base64
    (callback) => {
      chpBinary.objectToBase64(proof, (err, proofBase64) => {
        if (err) return callback(err)
        return callback(null, proofBase64)
      })
    },
    // save proof to redis
    (proofBase64, callback) => {
      redis.set(messageObj.hash_id, proofBase64, 'EX', env.PROOF_EXPIRE_MINUTES * 60, (err, res) => {
        if (err) return callback(err)
        return callback(null)
      })
    },
    (callback) => {
      // check if a subscription for the hash exists
      // Preface the sub key with 'sub:' so as not to conflict with the proof storage, which uses the plain hashId as the key already
      let key = 'sub:' + messageObj.hash_id
      redis.hgetall(key, (err, res) => {
        if (err) return callback(err)
        // if not subscription is found, return null to skip the rest of the process
        if (res == null || !res.api_id || !res.cx_id) return callback(null, null, null)
        // a subscription with valid api_id and cx_id has been found, return api_id and cx_id to deliver the proof to
        return callback(null, res.api_id, res.cx_id)
      })
    },
    // publish 'ready' message for API service if and only if a subscription exists for this hash
    (APIServiceInstanceId, wsConnectionId, callback) => {
      // no subcription fvor this hash, so skip publishing
      if (APIServiceInstanceId == null || wsConnectionId == null) return callback(null)

      let opts = { headers: { 'api_id': APIServiceInstanceId }, persistent: true }
      let message = {
        cx_id: wsConnectionId,
        hash_id: messageObj.hash_id
      }
      amqpChannel.publish(env.RMQ_OUTGOING_EXCHANGE, '', Buffer.from(JSON.stringify(message)), opts,
        (err, ok) => {
          if (err !== null) {
            // An error as occurred publishing a message
            console.error(env.RMQ_WORK_OUT_API_QUEUE, 'publish message nacked')
            return callback(err)
          } else {
            // New message has been published
            console.log(env.RMQ_WORK_OUT_API_QUEUE, 'publish message acked')
            return callback(null)
          }
        })
    }
  ],
    (err) => {
      if (err) {
        // An error has occurred saving the proof and publishing the ready message, nack consumption of message
        amqpChannel.nack(msg)
        console.error(env.RMQ_WORK_IN_GEN_QUEUE, '[cal] consume message nacked')
      } else {
        amqpChannel.ack(msg)
        console.log(env.RMQ_WORK_IN_GEN_QUEUE, '[cal] consume message acked')
      }
    })
}

function generateBTCProof (msg) {
  let messageObj = JSON.parse(msg.content.toString())

  let proof = {}
  proof = addChainpointHeader(proof, messageObj.hash, messageObj.hash_id)
  proof = addCalendarBranch(proof, messageObj.agg_state, messageObj.cal_state)
  proof = addBtcBranch(proof, messageObj.anchor_agg_state, messageObj.btctx_state, messageObj.btchead_state)

  // ensure the proof is valid according to the defined Chainpoint v3 JSON schema
  let isValidSchema = chainpointProofSchema.validate(proof).valid
  if (!isValidSchema) {
    // This schema is not valid, ack the message but log an error and end processing
    // We are not nacking here because the poorly formatted proof would just be
    // re-qeueud and re-processed on and on forever
    amqpChannel.ack(msg)
    console.error(env.RMQ_WORK_IN_GEN_QUEUE, 'consume message acked, but with invalid JSON schema error')
    return
  }

  async.waterfall([
    // compress proof to binary format Base64
    (callback) => {
      chpBinary.objectToBase64(proof, (err, proofBase64) => {
        if (err) return callback(err)
        return callback(null, proofBase64)
      })
    },
    // save proof to redis
    (proofBase64, callback) => {
      redis.set(messageObj.hash_id, proofBase64, 'EX', env.PROOF_EXPIRE_MINUTES * 60, (err, res) => {
        if (err) return callback(err)
        return callback(null)
      })
    },
    (callback) => {
      // check if a subscription for the hash exists
      // Preface the sub key with 'sub:' so as not to conflict with the proof storage, which uses the plain hashId as the key already
      let key = 'sub:' + messageObj.hash_id
      redis.hgetall(key, (err, res) => {
        if (err) return callback(err)
        // if not subscription is found, return null to skip the rest of the process
        if (res == null || !res.api_id || !res.cx_id) return callback(null, null, null)
        // a subscription with valid api_id and cx_id has been found, return api_id and cx_id to deliver the proof to
        return callback(null, res.api_id, res.cx_id)
      })
    },
    // publish 'ready' message for API service if and only if a subscription exists for this hash
    (APIServiceInstanceId, wsConnectionId, callback) => {
      // no subcription fvor this hash, so skip publishing
      if (APIServiceInstanceId == null || wsConnectionId == null) return callback(null)

      let opts = { headers: { 'api_id': APIServiceInstanceId }, persistent: true }
      let message = {
        cx_id: wsConnectionId,
        hash_id: messageObj.hash_id
      }
      amqpChannel.publish(env.RMQ_OUTGOING_EXCHANGE, '', Buffer.from(JSON.stringify(message)), opts,
        (err, ok) => {
          if (err !== null) {
            // An error as occurred publishing a message
            console.error(env.RMQ_WORK_OUT_API_QUEUE, 'publish message nacked')
            return callback(err)
          } else {
            // New message has been published
            console.log(env.RMQ_WORK_OUT_API_QUEUE, 'publish message acked')
            return callback(null)
          }
        })
    }
  ],
    (err) => {
      if (err) {
        // An error has occurred saving the proof and publishing the ready message, nack consumption of message
        amqpChannel.nack(msg)
        console.error(env.RMQ_WORK_IN_GEN_QUEUE, '[btc] consume message nacked')
      } else {
        amqpChannel.ack(msg)
        console.log(env.RMQ_WORK_IN_GEN_QUEUE, '[btc] consume message acked')
      }
    })
}

function generateETHProof (msg) {
  console.log('building eth proof')
}

function addChainpointHeader (proof, hash, hashId) {
  proof['@context'] = 'https://w3id.org/chainpoint/v3'
  proof.type = 'Chainpoint'
  proof.hash = hash
  proof.hash_id = hashId
  proof.hash_submitted_at = formatDateISO8601NoMs(new Date(uuidTime.v1(hashId)))
  return proof
}

function addCalendarBranch (proof, aggState, calState) {
  let calendarBranch = {}
  calendarBranch.label = 'cal_anchor_branch'
  calendarBranch.ops = aggState.ops.concat(calState.ops)

  let calendarAnchor = {}
  calendarAnchor.type = 'cal'
  calendarAnchor.anchor_id = calState.anchor.anchor_id
  calendarAnchor.uris = calState.anchor.uris

  calendarBranch.ops.push({ anchors: [calendarAnchor] })

  proof.branches = [calendarBranch]
  return proof
}

function addBtcBranch (proof, anchorAggState, btcTxState, btcHeadState) {
  let btcBranch = {}
  btcBranch.label = 'btc_anchor_branch'
  btcBranch.ops = anchorAggState.ops.concat(btcTxState.ops, btcHeadState.ops)

  let btcAnchor = {}
  btcAnchor.type = 'btc'
  btcAnchor.anchor_id = btcHeadState.anchor.anchor_id

  btcBranch.ops.push({ anchors: [btcAnchor] })

  proof.branches[0].branches = [btcBranch]
  return proof
}

/**
* Parses a message and performs the required work for that message
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
function processMessage (msg) {
  if (msg !== null) {
    // determine the source of the message and handle appropriately
    switch (msg.properties.type) {
      case 'cal':
        // Consumes a generate calendar proof message
        generateCALProof(msg)
        break
      case 'eth':
        // Consumes a generate eth anchor proof message
        generateETHProof(msg)
        break
      case 'btc':
        // Consumes a generate btc anchor proof message
        generateBTCProof(msg)
        break
      default:
        // This is an unknown state type
        console.error('Unknown state type', msg.properties.type)
    }
  }
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectionString - The connection string for the RabbitMQ instance, an AMQP URI
 */
function amqpOpenConnection (connectionString) {
  async.waterfall([
    (callback) => {
      // connect to rabbitmq server
      amqp.connect(connectionString, (err, conn) => {
        if (err) return callback(err)
        return callback(null, conn)
      })
    },
    (conn, callback) => {
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        setTimeout(amqpOpenConnection.bind(null, connectionString), 5 * 1000)
      })
      // create communication channel
      conn.createConfirmChannel((err, chan) => {
        if (err) return callback(err)
        // the connection and channel have been established
        // set 'amqpChannel' so that publishers have access to the channel
        console.log('RabbitMQ connection established')
        chan.assertQueue(env.RMQ_WORK_IN_GEN_QUEUE, { durable: true })
        chan.assertExchange(env.RMQ_OUTGOING_EXCHANGE, 'headers', { durable: true })
        chan.prefetch(env.RMQ_PREFETCH_COUNT_GEN)
        amqpChannel = chan
        // Continuously load the HASHES from RMQ with hash objects to process
        chan.consume(env.RMQ_WORK_IN_GEN_QUEUE, (msg) => {
          processMessage(msg)
        })
        return callback(null)
      })
    }
  ], (err) => {
    if (err) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish RabbitMQ connection. Attempting in 5 seconds...')
      setTimeout(amqpOpenConnection.bind(null, connectionString), 5 * 1000)
    }
  })
}

// Open amqp connection
amqpOpenConnection(env.RABBITMQ_CONNECT_URI)

// REDIS initialization
openRedisConnection(env.REDIS_CONNECT_URI)
