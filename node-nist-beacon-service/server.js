/* Copyright (C) 2018 Tierion
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// load all environment variables into env object
const env = require('./lib/parse-env.js')('nist')

const BEACON = require('nist-randomness-beacon')
const cnsl = require('consul')
const connections = require('./lib/connections.js')

let consul = null

async function getNistLatestAsync () {
  try {
    let result = await BEACON.getMostRecentPulse()
    
    // A pulse object being returned without error implies
    // a well formatted, content and signature verified pulse
    let timestampMS = new Date(result.pulse.timeStamp).getTime()
    let timeAndSeed = `${timestampMS}:${result.pulse.localRandomValue}`.toLowerCase()

    // The latest NIST value will always be stored under
    // a known key which can always be used if present.
    // It will be updated every minute if the service API
    // is available. Clients that are watching this key
    // should gracefully handle null values for this key.
    consul.kv.get(env.NIST_KEY, function (err, result) {
      if (err) {
        console.error(err)
      } else {
        // Only write to the key if the value changed.
        if (!result || result.Value !== timeAndSeed) {
          console.log(`New NIST value received: ${timeAndSeed}`)
          consul.kv.set(env.NIST_KEY, timeAndSeed, function (err, result) {
            if (err) throw err
          })
        }
      }
    })
  } catch (error) {
    console.error(error)
  }
}

function startIntervals () {
  let intervals = [{
    function: () => {
      try {
        getNistLatestAsync()
      } catch (error) {
        console.error(`getNistLatest : caught err : ${error.message}`)
      }
    },
    immediate: true, // run this once immediately
    ms: env.NIST_INTERVAL_MS
  }]
  connections.startIntervals(intervals)
}

async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init consul
    consul = connections.initConsul(cnsl, env.CONSUL_HOST, env.CONSUL_PORT)
    // init interval functions
    startIntervals()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

start()
