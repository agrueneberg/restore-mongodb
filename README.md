restore-mongodb
===============

A MongoDB adapter for [reStore](https://github.com/jcoglan/restore), a remoteStorage server.


Status
------

Experimental, not well tested.


How to use it
-------------

The following Node script will run a basic server:

    var reStore, MongoDbStore, store, server;

    reStore = require("restore");
    MongoDbStore = require("restore-mongodb");

    store = new MongoDbStore({
        host: "localhost",    // default: localhost
        port: 27017,          // default: 27017
        database: "restore",  // default: restore
        username: "john",     // optional
        password: "12345"     // optional
    });

    server = new reStore({
        store: store,
        http: {
            port: 8000
        }
    });

    server.boot();


How to run the tests
--------------------

- Start MongoDB
- `git submodule update --init`
- `npm install`
- `npm test`
