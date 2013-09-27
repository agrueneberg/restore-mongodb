var MongoDB;

MongoDB = require("../lib/restore-mongodb");

JS.Test.describe("MongoDB store", function () {

    with(this) {

    before(function () {
        with(this) {
            stub(require("../lib/utils"), "hashRounds", 1)
            store = new MongoDB({
                host: "localhost",
                port: 27017,
                database: "restore-test"
            })
        }
    })

    after(function (resume) {
        with(this) {
            store.getClient.then(function (client) {
                client.dropDatabase(function (err, result) {
                    client.close(function (err, result) {
                        resume()
                    })
                })
            })
        }
    })

    itShouldBehaveLike("storage backend")

}})
