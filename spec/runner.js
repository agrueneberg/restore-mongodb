process.env.SILENT = "1"

var JS = require("jstest")

require("../vendor/restore/spec/restore/storage_spec")
require("../vendor/restore/spec/store_spec.js")
require("./mongodb_spec")

JS.Test.autorun()
