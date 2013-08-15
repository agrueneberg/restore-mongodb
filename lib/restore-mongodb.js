"use strict";

var async, utils, MongoDbStore;

async = require("async");
utils = require("./utils");

MongoDbStore = function (options) {

    var MongoClient, host, port, db, username, password, clientQueue, creatingClient, self, connstr;

    this._options = options || {};
    this._client = null;

    MongoClient = require("mongodb").MongoClient;

    host = this._options.host || this.DEFAULT_HOST;
    port = this._options.port || this.DEFAULT_PORT;
    db = this._options.database || this.DEFAULT_DATABASE;
    username = this._options.username;
    password = this._options.password;
    clientQueue = [];
    creatingClient = false;
    self = this;
    connstr = null;

    if (username && password) {
        connstr = "mongodb://" + username + ":" + password + "@" + host + ":" + port + "/" + db;
    } else {
        connstr = "mongodb://" + host + ":" + port + "/" + db;
    }

    this.getClient = function (callback) {
        var self;
        self = this;
        if (this._client !== null) {
            callback(null, this._client);
        } else {
            clientQueue.push(callback);
            if (creatingClient === false) {
                creatingClient = true;
                MongoClient.connect(connstr, function (err, client) {
                    if (err !== null) {
                        callback(err, null);
                    } else {
                        self._client = client;
                        clientQueue.forEach(function (callback) {
                            callback(null, self._client);
                        });
                        clientQueue = [];
                        creatingClient = false;
                    }
                });
            }
        }
    };

};

MongoDbStore.prototype.DEFAULT_HOST = "localhost";
MongoDbStore.prototype.DEFAULT_PORT = 27017;
MongoDbStore.prototype.DEFAULT_DATABASE = "restore";

MongoDbStore.prototype.createUser = function (params, callback) {
    var errs;
    errs = utils.validateUser(params);
    if (errs.length > 0) {
        callback(errs[0]);
    } else {
        this.getClient(function (err, client) {
            utils.hashPassword(params.password, null, function (err, password) {
                client.collection("users", function (err, collection) {
                    collection.find({
                        username: params.username
                    }, {
                        limit: 1
                    }).count(true, function (err, exists) {
                        if (exists === 1) {
                            callback(new Error("The username is already taken"));
                        } else {
                            collection.insert({
                                username: params.username,
                                password: password,
                                email: params.email
                            }, function () {
                                callback(null);
                            });
                        }
                    });
                });
            });
        });
    }
};

MongoDbStore.prototype.authenticate = function (params, callback) {
    var username;
    username = params.username || "";
    this.getClient(function (err, client) {
        client.collection("users", function (err, collection) {
            collection.findOne({
                username: username
            }, function (err, user) {
                if (user === null) {
                    callback(new Error("Username not found"));
                } else {
                    var key;
                    key = user.password.key;
                    utils.hashPassword(params.password, user.password, function (err, password) {
                        if (password.key === key) {
                            callback(null);
                        } else {
                            callback(new Error("Incorrect password"));
                        }
                    });
                }
            });
        });
    });
};

MongoDbStore.prototype.authorize = function (clientId, username, permissions, callback) {
    var token;
    token = utils.generateToken();
    this.getClient(function (err, client) {
        client.collection("sessions", function (err, collection) {
            collection.insert({
                username: username,
                token: token,
                permissions: permissions
            }, function (err) {
                if (err !== null) {
                    callback(err, null);
                } else {
                    callback(null, token);
                }
            });
        });
    });
};

MongoDbStore.prototype.revokeAccess = function (username, token, callback) {
    callback = callback || function () {};
    this.getClient(function (err, client) {
        client.collection("sessions", function (err, collection) {
            collection.remove({
                username: username,
                token: token
            }, callback);
        });
    });
};

MongoDbStore.prototype.permissions = function (username, token, callback) {
    this.getClient(function (err, client) {
        client.collection("sessions", function (err, collection) {
            collection.findOne({
                username: username,
                token: token
            }, function (err, session) {
                if (err !== null || session === null) {
                    callback(err, {});
                } else {
                 // Normalize permissions: folder -> /folder/
                    var permissions = {};
                    Object.keys(session.permissions).forEach(function (permission) {
                        var perm;
                        perm = permission.replace(/^\/?/, "/").replace(/\/?$/, "/");
                        permissions[perm] = session.permissions[permission];
                    });
                    callback(null, permissions);
                }
            });
        });
    });
};

MongoDbStore.prototype.get = function (username, path, version, callback) {
    var isdir, fields;
    isdir = /\/$/.test(path);
    if (isdir === true) {
        fields = {
            children: 1
        };
    } else {
        fields = {
            modified: 1,
            type: 1,
            value: 1
        };
    }
    this.getClient(function (err, client) {
        client.collection("nodes", function (err, collection) {
            collection.findOne({
                name: path,
                username: username
            }, fields, function (err, node) {
                if (err !== null || node === null) {
                    callback(err, null, false);
                } else {
                 // Do not expose MongoDB stuff
                    delete node._id;
                    if (isdir === true) {
                        node.children = node.children.map(function (child) {
                            child.modified = parseInt(child.modified, 10);
                            return child;
                        });
                        callback(err, node.children);
                    } else {
                        node.modified = parseInt(node.modified, 10);
                        node.value = node.value.buffer;
                        callback(err, node, version === node.modified);
                    }
                }
            });
        });
    });
};

MongoDbStore.prototype.put = function (username, path, type, value, version, callback) {
    var self, query, documentName;
    self = this;
    query = utils.parsePath(path);
    documentName = query.pop();
    this.getClient(function (err, client) {
        client.collection("nodes", function (err, collection) {
            self.isCurrentVersion(collection, path, username, version, function (err, iscurrent) {
                if (err || !iscurrent) {
                    callback(err, false, null, true);
                } else {
                    var modified;
                    modified = new Date().getTime().toString().replace(/...$/, "000");
                    async.forEach(utils.indexed(query), function (entry, done) {
                        var folderName, childName;
                        folderName = query.slice(0, entry.index + 1).join("");
                        childName = query[entry.index + 1] || documentName;
                        collection.update({
                            name: folderName,
                            username: username
                        }, {
                            $set: {
                                modified: modified
                            },
                            $addToSet: {
                                children: {
                                    name: childName
                                }
                            }
                        }, {
                            upsert: true
                        }, function (err) {
                            collection.update({
                                name: folderName,
                                username: username,
                                "children.name": childName
                            }, {
                                $set: {
                                    "children.$.modified": modified
                                }
                            }, function (err) {
                                done();
                            });
                        });
                    }, function () {
                        collection.update({
                            name: path,
                            username: username
                        }, {
                            $set: {
                                modified: modified,
                                type: type,
                                value: value
                            }
                        }, {
                            upsert: true
                        }, function (err, result, status) {
                            callback(err, !status.updatedExisting, parseInt(modified, 10));
                        });
                    });
                }
            });
        });
    });
};

MongoDbStore.prototype.delete = function (username, path, version, callback) {
    var self, query, documentName, parentFolder;
    self = this;
    query = utils.parsePath(path);
    documentName = query.pop();
    parentFolder = query.join("");
    this.getClient(function (err, client) {
        client.collection("nodes", function (err, collection) {
            self.isCurrentVersion(collection, path, username, version, function (err, iscurrent, modified) {
                if (err || !iscurrent) {
                    callback(err, false, null, true);
                } else {
                 // Remove document
                    collection.remove({
                        name: path,
                        username: username
                    }, function (err, numRemoved) {
                        if (numRemoved === 0) {
                            callback(err, false, modified);
                        } else {
                         // Remove document from parent folder
                            collection.update({
                                name: parentFolder,
                                username: username
                            }, {
                                $pull: {
                                    children: {
                                        name: documentName
                                    }
                                }
                            }, function (err) {
                                self._removeParents(collection, username, path, function () {
                                    callback(err, true, modified);
                                });
                            });
                        }
                    });
                }
            });
        });
    });
};

MongoDbStore.prototype.isCurrentVersion = function (collection, path, username, version, callback) {
    collection.findOne({
        name: path,
        username: username
    }, {
        modified: 1
    }, function (err, node) {
        if (err !== null) {
            callback(err, false);
        } else {
            var mtime;
            mtime = node && parseInt(node.modified, 10);
            if (!version) {
                callback(null, true, mtime);
            } else {
                callback(null, mtime === version, mtime);
            }
        }
    });
};

MongoDbStore.prototype._removeParents = function (collection, username, path, callback) {
    var self, query, documentName, parents;
    self = this;
    query = utils.parsePath(path);
    documentName = query.pop();
    parents = utils.parents(path);
    async.forEachSeries(utils.indexed(parents), function (entry, done) {
        var parentFolder, i, currentFolder;
        parentFolder = entry.value;
        i = entry.index;
        currentFolder = parents[i - 1];
     // Skip the first one
        if (i === 0) {
            done();
        } else {
         // Find out if folder has children
            collection.findOne({
                name: currentFolder,
                username: username
            }, {
                children: 1
            }, function (err, node) {
                if (node.children.length === 0) {
                 // Remove empty folder
                    collection.remove({
                        name: currentFolder,
                        username: username
                    }, function (err) {
                     // Remove empty folder from parent
                        collection.update({
                            name: parentFolder,
                            username: username
                        }, {
                            $pull: {
                                children: {
                                    name: query[query.length - i]
                                }
                            }
                        }, function (err) {
                            done();
                        });
                    });
                } else {
                    self._updateMtime(collection, currentFolder, username, node.children, done);
                }
            });
        }
    }, callback);
};

MongoDbStore.prototype._updateMtime = function (collection, path, username, children, callback) {
    async.map(children, function (child, callback) {
        collection.findOne({
            name: path + child.name,
            username: username
        }, {
            modified: 1
        }, function (err, node) {
            callback(err, parseInt(node.modified, 10));
        });
    }, function (err, mtimes) {
        collection.update({
            name: path,
            username: username
        }, {
            $set: {
                modified: Math.max.apply(Math, mtimes)
            }
        }, callback);
    });
};

module.exports = MongoDbStore;
