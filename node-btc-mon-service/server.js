const async = require('async')
const _ = require('lodash')
require('dotenv').config()

// just a temp function
let finalize = function () {
  console.log('BTC TX monitoring...')
}

setInterval(() => finalize(), 1000)