"use strict";

var mongodb, async, q, utils, MongoDbStore;

mongodb = require("mongodb");
async = require("async");
q = require("q");
utils = require("./utils");

MongoDbStore = function (options) {
    var deferred, connectionString;
    options = options || {};
    options.host = options.host || this.DEFAULT_HOST;
    options.port = options.port || this.DEFAULT_PORT;
    options.db = options.database || this.DEFAULT_DATABASE;
    deferred = q.defer();
    if (options.username && options.password) {
        connectionString = "mongodb://" + options.username + ":" + options.password + "@" + options.host + ":" + options.port + "/" + options.db;
    } else {
        connectionString = "mongodb://" + options.host + ":" + options.port + "/" + options.db;
    }
    mongodb.MongoClient.connect(connectionString, function (err, client) {
        if (err !== null) {
            deferred.reject(err);
        } else {
            deferred.resolve(client);
        }
    });
    this.getClient = deferred.promise;
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
        this.getClient.then(function (client) {
            client.collection("users", function (err, collection) {
                collection.find({
                    username: params.username
                }, {
                    limit: 1
                }).count(true, function (err, exists) {
                    if (exists === 1) {
                        callback(new Error("The username is already taken"));
                    } else {
                        utils.hashPassword(params.password, null, function (err, password) {
                            collection.insert({
                                username: params.username,
                                password: password,
                                email: params.email
                            }, function () {
                                callback(null);
                            });
                        });
                    }
                });
            });
        });
    }
};

MongoDbStore.prototype.authenticate = function (params, callback) {
    this.getClient.then(function (client) {
        client.collection("users", function (err, collection) {
            var username;
            username = params.username || "";
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
    this.getClient.then(function (client) {
        client.collection("sessions", function (err, collection) {
            var token;
            token = utils.generateToken();
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
    this.getClient.then(function (client) {
        client.collection("sessions", function (err, collection) {
            collection.remove({
                username: username,
                token: token
            }, function () {
                callback();
            });
        });
    });
};

MongoDbStore.prototype.permissions = function (username, token, callback) {
    this.getClient.then(function (client) {
        client.collection("sessions", function (err, collection) {
            collection.findOne({
                username: username,
                token: token
            }, function (err, session) {
                if (err !== null || session === null) {
                    callback(err, {});
                } else {
                 // Normalize permissions: folder -> /folder/
                    var permissions;
                    permissions = {};
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
    this.getClient.then(function (client) {
        var isDir, fields;
        isDir = /\/$/.test(path);
        if (isDir === true) {
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
                    if (isDir === true) {
                        callback(err, node.children);
                    } else {
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
    this.getClient.then(function (client) {
        client.collection("nodes", function (err, collection) {
            self.isCurrentVersion(collection, path, username, version, function (err, iscurrent) {
                if (err || !iscurrent) {
                    callback(err, false, null, true);
                } else {
                    var modified;
                    modified = parseInt(new Date().getTime().toString().replace(/...$/, "000"));
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
                            callback(err, !status.updatedExisting, modified);
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
    this.getClient.then(function (client) {
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
            mtime = node && node.modified;
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
            callback(err, node.modified);
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
