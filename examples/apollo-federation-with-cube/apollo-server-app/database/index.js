const postgres = require('postgres')
const sql = postgres('postgresql://cube:12345@demo-db-examples.cube.dev:5432/fraud', { max: 10 })
module.exports = sql
