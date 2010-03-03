sys = require("sys");

var mongo = require('mongodb/bson/bson');
process.mixin(mongo, require('mongodb/bson/collections'));
process.mixin(mongo, require('mongodb/gridfs/chunk'));
process.mixin(mongo, require('mongodb/commands/db_command'));
process.mixin(mongo, require('mongodb/goog/math/integer'));
process.mixin(mongo, require('mongodb/goog/math/long'));

exports.GridStore = Class({
  init: function(db, filename, mode, options) {  
    this.db = db;
    this.filename = filename;
    this.mode = mode == null ? "r" : mode;
    this.options = options == null ? {} : options;
    this.root = this.options['root'] == null ? exports.GridStore.DEFAULT_ROOT_COLLECTION : this.options['root'];      
    this.position = 0;
    this.className = "GridStore";    
    // Getters and Setters
    this.__defineGetter__("chunkSize", function() { return this.internalChunkSize; });
    this.__defineSetter__("chunkSize", function(value) { 
      if(!(this.mode[0] == "w" && this.position == 0 && this.uploadDate == null)) {
        this.internalChunkSize = this.internalChunkSize;       
      } else {
        this.internalChunkSize = value;
      }
    });  
    this.__defineGetter__("md5", function() { return this.internalMd5; });
    this.__defineSetter__("md5", function(value) {});      
  },
  
  open: function(callback) {
    var self = this;

    this.collection(function(err, collection) {
      collection.find({'filename':self.filename}, function(err, cursor) {
        cursor.nextObject(function(err, doc) {        
          // Chek if the collection for the files exists otherwise prepare the new one
          if(doc != null) {
            self.fileId = doc._id;
            self.contentType = doc.contentType;
            self.internalChunkSize = doc.chunkSize;
            self.uploadDate = doc.uploadDate;
            self.aliases = doc.aliases;
            self.length = doc.length;
            self.metadata = doc.metadata;
            self.internalMd5 = doc.md5;
          } else {
            self.fileId = new mongo.ObjectID();
            self.contentType = exports.GridStore.DEFAULT_CONTENT_TYPE;
            self.internalChunkSize = mongo.Chunk.DEFAULT_CHUNK_SIZE;
            self.length = 0;
          }        

          // Process the mode of the object
          if(self.mode == "r") {
            self.nthChunk(0, function(err, chunk) {
              self.currentChunk = chunk;
              self.position = 0;
              callback(null, self);
            });
          } else if(self.mode == "w") {
            self.chunkCollection(function(err, collection2) {
              // Create index for the chunks
              collection.createIndex([['files_id', 1], ['n', 1]], function(err, index) {
                // Delete any existing chunks
                self.deleteChunks(function(err, result) {
                  self.currentChunk = new mongo.Chunk(self, {'n':0});
                  self.contentType = self.options['content_type'] == null ? self.contentType : self.options['content_type'];
                  self.internalChunkSize = self.options['chunk_size'] == null ? self.internalChunkSize : self.options['chunk_size'];
                  self.metadata = self.options['metadata'] == null ? self.metadata : self.options['metadata'];
                  self.position = 0;
                  callback(null, self);
                });
              });
            });
          } else if(self.mode == "w+") {
            self.chunkCollection(function(err, collection) {
              // Create index for the chunks
              collection.createIndex([['files_id', 1], ['n', 1]], function(err, index) {
                self.nthChunk(self.lastChunkNumber, function(err, chunk) {
                  // Set the current chunk
                  self.currentChunk = chunk == null ? new mongo.Chunk(self, {'n':0}) : chunk;
                  self.currentChunk.position = self.currentChunk.data.length();
                  self.metadata = self.options['metadata'] == null ? self.metadata : self.options['metadata'];
                  self.position = self.length;
                  callback(null, self);
                });
              })
            });          
          } else {
            callback(new Error("Illegal mode " + self.mode), null);
          }
        });
      });      
    });
  },
  
  write: function(string, close, callback) {
    if(typeof close === "function") { callback = close; close = null}
    var self = this;
    var finalClose = close == null ? false : close;

    if(self.mode[0] != "w") {
      callback(new Error(self.filename + " not opened for writing"), null);
    } else {
      if((self.currentChunk.position + string.length) > self.chunkSize) {
        var previousChunkNumber = self.currentChunk.chunkNumber;
        var leftOverDataSize = self.chunkSize - self.currentChunk.position;
        var previousChunkData = string.substr(0, leftOverDataSize);
        var leftOverData = string.substr(leftOverData, (string.length - leftOverDataSize));
        // Let's finish the current chunk and then call write again for the remaining data
        self.currentChunk.write(previousChunkData, function(err, chunk) {
          chunk.save(function(err, result) {
            self.currentChunk = new mongo.Chunk(self, {'n': (previousChunkNumber + 1)});
            self.position = self.position + leftOverDataSize;        
            // Write the remaining data
            self.write(leftOverData, function(err, gridStore) {
              if(finalClose) {
                self.close(function(err, result) {
                  callback(null, gridStore);
                });
              } else {
                callback(null, gridStore);
              }
            });
          });              
        });
      } else {
        self.currentChunk.write(string, function(err, chunk) {
          self.position = self.position + string.length;
          if(finalClose) {
            self.close(function(err, result) {
              callback(null, self);
            });
          } else {
            callback(null, self);
          }          
        });      
      }
    }
  },
  
  buildMongoObject: function(callback) {
    // var mongoObject = new mongo.OrderedHash();
    var length = this.currentChunk != null ? (this.currentChunk.chunkNumber * this.chunkSize + this.currentChunk.position - 1) : 0;
    var mongoObject = {'_id': this.fileId,
      'filename': this.filename,
      'contentType': this.contentType,
      'length': length < 0 ? 0 : length,
      'chunkSize': this.chunkSize,
      'uploadDate': this.uploadDate,
      'aliases': this.aliases,
      'metadata': this.metadata}

    var md5Command = new mongo.OrderedHash();
    md5Command.add('filemd5', this.fileId).add('root', this.root);

    this.db.command(md5Command, function(err, results) {
      mongoObject.md5 = results.md5;
      callback(mongoObject);
    });
  },
  
  close: function(callback) {
    var self = this;

    if(self.mode[0] == "w") {
      if(self.currentChunk != null && self.currentChunk.position > 0) {
        self.currentChunk.save(function(err, chuck) {
          self.collection(function(err, files) {
            // Build the mongo object
            if(self.uploadDate != null) {
              files.remove({'_id':self.fileId}, function(err, collection) {
                self.buildMongoObject(function(mongoObject) {
                  files.save(mongoObject, function(err, doc) {
                    callback(err, doc);
                  });
                });          
              });
            } else {
              self.uploadDate = new Date();
              self.buildMongoObject(function(mongoObject) {
                files.save( mongoObject, function(err, doc) {
                  callback(err, doc);
                });
              });          
            }            
          });
        });
      } else {
        self.collection(function(err, files) {
          self.uploadDate = new Date();
          self.buildMongoObject(function(mongoObject) {
            files.save(mongoObject, function(err, doc) {
              callback(err, doc);
            });
          });          
        });
      }
    } else {
      callback(new Error("Illegal mode " + self.mode), null);
    }
  },
  
  nthChunk: function(chunkNumber, callback) {
    var self = this;

    self.chunkCollection(function(err, collection) {
      collection.find({'files_id':self.fileId, 'n':chunkNumber}, function(err, cursor) {
        cursor.nextObject(function(err, chunk) {        
          var finalChunk = chunk == null ? {} : chunk;
          callback(null, new mongo.Chunk(self, finalChunk));
        });
      });
    });
  },
  
  lastChunkNumber: function() {
    return mongo.Integer.fromNumber((self.length/self.chunkSize)).toInt();
  },
  
  chunkCollection: function(callback) {
    this.db.collection((this.root + ".chunks"), callback);
  },
  
  deleteChunks: function(callback) {
    var self = this;

    if(self.fileId != null) {
      self.chunkCollection(function(err, collection) {
        collection.remove({'files_id':self.fileId}, function(err, result) {
          callback(null, true);
        });
      });
    } else {
      callback(null, true);
    }
  },
  
  collection: function(callback) {
    this.db.collection(this.root + ".files", function(err, collection) {
      callback(err, collection);
    });
  },
  
  readlines: function(separator, callback) {
    var args = Array.prototype.slice.call(arguments, 0);
    callback = args.pop();
    separator = args.length ? args.shift() : null;

    this.read(function(err, data) {
      var items = data.split(separator);
      items = items.length > 0 ? items.splice(0, items.length - 1) : [];
      for(var i = 0; i < items.length; i++) {
        items[i] = items[i] + separator;
      }
      callback(null, items);
    });
  },
  
  rewind: function(callback) {
    var self = this;

    if(this.currentChunk.chunkNumber != 0) {
      if(this.mode[0] == "w") {
        self.deleteChunks(function(err, gridStore) {
          self.currentChunk = new mongo.Chunk(self, {'n': 0});
          self.position = 0;
          callback(null, self);
        });
      } else {
        self.currentChunk(0, function(err, chunk) {
          self.currentChunk = chunk;
          self.currentChunk.rewind();
          self.position = 0;        
          callback(null, self);
        });
      }
    } else {
      self.currentChunk.rewind();
      self.position = 0;    
      callback(null, self);
    }
  }, 
  
  read: function(length, buffer, callback) {
    var self = this;

    var args = Array.prototype.slice.call(arguments, 0);
    callback = args.pop();
    length = args.length ? args.shift() : null;
    buffer = args.length ? args.shift() : null;   
    
    // The data is a c-terminated string and thus the length - 1
    var finalBuffer = buffer == null ? '' : buffer;
    var finalLength = length == null ? self.length - self.position : length;
    var numberToRead = finalLength;

    if((self.currentChunk.length() - self.currentChunk.position + 1 + finalBuffer.length) >= finalLength) {
      finalBuffer = finalBuffer + self.currentChunk.read(finalLength - finalBuffer.length);
      numberToRead = numberToRead - finalLength;
      self.position = finalBuffer.length;
      callback(null, finalBuffer);
    } else {
      finalBuffer = finalBuffer + self.currentChunk.read(self.currentChunk.length());
      numberToRead = numberToRead - self.currentChunk.length();
      // Load the next chunk and read some more
      self.nthChunk(self.currentChunk.chunkNumber + 1, function(err, chunk) {
        self.currentChunk = chunk;
        self.read(length, finalBuffer, callback);
      });
    }  
  },
  
  tell: function(callback) {
    callback(null, this.position);
  },
  
  seek: function(position, seekLocation, callback) {
    var self = this;  

    var args = Array.prototype.slice.call(arguments, 1);
    callback = args.pop();
    seekLocation = args.length ? args.shift() : null;

    var seekLocationFinal = seekLocation == null ? exports.GridStore.IO_SEEK_SET : seekLocation;
    var finalPosition = position;
    var targetPosition = 0;
    if(seekLocationFinal == exports.GridStore.IO_SEEK_CUR) {
      targetPosition = self.position + finalPosition;
    } else if(seekLocationFinal == exports.GridStore.IO_SEEK_END) {
      targetPosition = self.length + finalPosition;
    } else {
      targetPosition = finalPosition;
    }

    var newChunkNumber = mongo.Integer.fromNumber((targetPosition/self.chunkSize)).toInt();
    if(newChunkNumber != self.currentChunk.chunkNumber) {
      if(self.mode[0] == 'w') {
        self.currentChunk.save(function(err, chunk) {
          self.nthChunk(newChunkNumber, function(err, chunk) {
            self.currentChunk = chunk;
            self.position = targetPosition;
            self.currentChunk.position = (self.position % self.chunkSize);
            callback(null, self);
          });
        });
      }
    } else {
      self.position = targetPosition;
      self.currentChunk.position = (self.position % self.chunkSize);
      callback(null, self);
    }
  },
  
  eof: function() {
    return this.position == this.length ? true : false;
  },
  
  getc: function(callback) {
    var self = this;

    if(self.eof()) {
      callback(null, null);
    } else if(self.currentChunk.eof()) {
      self.nthChunk(self.currentChunk.chunkNumber + 1, function(err, chunk) {
        self.currentChunk = chunk;
        self.position = self.position + 1;
        callback(null, self.currentChunk.getc());
      });
    } else {
      self.position = self.position + 1;
      callback(null, self.currentChunk.getc());    
    }
  },
  
  puts: function(string, callback) {
    var finalString = string.match(/\n$/) == null ? string + "\n" : string;
    this.write(finalString, callback);
  }  
})

exports.GridStore.DEFAULT_ROOT_COLLECTION = 'fs';
exports.GridStore.DEFAULT_CONTENT_TYPE = 'text/plain';
exports.GridStore.IO_SEEK_SET = 0;
exports.GridStore.IO_SEEK_CUR = 1;
exports.GridStore.IO_SEEK_END = 2;

exports.GridStore.exist = function(db, name, rootCollection, callback) {
  var args = Array.prototype.slice.call(arguments, 2);
  callback = args.pop();
  rootCollection = args.length ? args.shift() : null;

  var rootCollectionFinal = rootCollection != null ? rootCollection : exports.GridStore.DEFAULT_ROOT_COLLECTION;
  db.collection(rootCollectionFinal + ".files", function(err, collection) {
    collection.find({'filename':name}, function(err, cursor) {
      cursor.nextObject(function(err, item) {
        callback(null, item == null ? false : true);
      });
    });
  });
}

exports.GridStore.list = function(db, rootCollection, callback) {
  if(typeof rootCollection === "function") { callback = rootCollection; rootCollection = null}    
  var rootCollectionFinal = rootCollection != null ? rootCollection : exports.GridStore.DEFAULT_ROOT_COLLECTION;
  var items = [];
  db.collection((rootCollectionFinal + ".files"), function(err, collection) {
    collection.find(function(err, cursor) {
     cursor.each(function(err, item) {
       if(item != null) {
         items.push(item.filename);
       } else {
         callback(null, items);
       }
     }); 
    });
  });
}

exports.GridStore.read = function(db, name, length, offset, callback) {  
  var args = Array.prototype.slice.call(arguments, 2);
  callback = args.pop();
  length = args.length ? args.shift() : null;
  offset = args.length ? args.shift() : null;

  var gridStore = new exports.GridStore(db, name, "r");
  gridStore.open(function(err, gridStore) {    
    if(offset != null) {
      gridStore.seek(offset, function(err, gridStore) {
        gridStore.read(length, function(err, data) {
          callback(err, data);
        });        
      });
    } else {
      gridStore.read(length, function(err, data) {
        callback(err, data);
      });
    }
  });
}

exports.GridStore.readlines = function(db, name, separator, callback) {  
  var args = Array.prototype.slice.call(arguments, 2);
  callback = args.pop();
  separator = args.length ? args.shift() : null;
  
  var finalSeperator = separator == null ? "\n" : separator;
  var gridStore = new exports.GridStore(db, name, "r");
  gridStore.open(function(err, gridStore) {    
    gridStore.readlines(finalSeperator, function(err, lines) {
      callback(err, lines);
    });
  });
}

exports.GridStore.unlink = function(db, names, callback) {
  var self = this;
  
  if(names.constructor == Array) {
    for(var i = 0; i < names.length; i++) {
      self.unlink(function(result) {
        if(i == (names.length - 1)) callback(null, self);
      }, db, names[i]);
    }
  } else {
    var gridStore = new exports.GridStore(db, names, "r");
    gridStore.open(function(err, gridStore) { 
      gridStore.deleteChunks(function(err, result) {
        gridStore.collection(function(err, collection) {
          collection.remove({'_id':gridStore.fileId}, function(err, collection) {
            callback(err, self);
          });
        });
      });
    });
  }
}



















