process.env.SILENT = "1"

require("jsclass")
JS.require("JS.Test")

require("../vendor/restore/spec/restore/storage_spec")
require("../vendor/restore/spec/store_spec.js")
require("./mongodb_spec")

JS.Test.autorun()
