'use strict';

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const diskusage = require('diskusage');
const debug = require('debug');

const debug_expire = debug('expire-fs:expire');
const debug_pressure = debug('expire-fs:pressure');
const debug_entry = debug('expire-fs:entry');

const readdirAsync = dirname => new Promise((res, rej) => fs.readdir(dirname, (e, l) => e ? rej(e) : res(l)));
const unlinkAsync = filename => new Promise((res, rej) => fs.unlink(filename, e => e ? rej(e) : res()));
const statsAsync = filename => new Promise((res, rej) => fs.stat(filename, (e, s) => e ? rej(e) : res(s)));
const rmdirAsync = filename => new Promise((res, rej) => fs.rmdir(filename, e => e ? rej(e) : res()));

const readdir = filename => fs.readdirSync(filename);
const unlink = filename => fs.unlinkSync(filename);
const stats = filename => fs.statSync(filename);
const rmdir = filename => fs.rmdirSync(filename);

const pretty_size = size => {
  const names = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (size > 1024 && i < names.length - 1) {
    i++;
    size /= 1024;
  }

  return `${size.toFixed(2)}${names[i]}`;
};

const validTimeTypes = new Set(['atime', 'mtime', 'ctime', 'birthtime']);

class ExpireEntry {
  /**
   * @param {boolean} async
   * @param {string} path
   * @param {ExpireEntry|null} parent
   */
  constructor({ async = false, path, parent }) {
    this._path = path;
    this._async = async;
    /**
     * @type {Stats}
     * @private
     */
    this._stats = null;

    this._parent = parent;
    /**
     * @type {Map<string, ExpireEntry>}
     * @private
     */
    this._children = new Map();

    /** @type function */
    this._get_list = async ? readdirAsync : readdir;
    /** @type function */
    this._get_stats = async ? statsAsync : stats;
    /** @type function */
    this._rm_dir = async ? rmdirAsync : rmdir;
    /** @type function */
    this._rm_file = async ? unlinkAsync : unlink;
  }

  /**
   * @return {string}
   */
  get path() {
    return this._path;
  }

  /**
   * @return {string}
   */
  get basename() {
    return path.basename(this._path);
  }

  /**
   * @return {boolean}
   */
  get isDir() {
    return this._stats.isDirectory();
  }

  /**
   * @param {ExpireFS.TimeType} type
   * @return {number}
   */
  getTime(type) {
    return this._stats[type];
  }

  /**
   * @return {number}
   */
  get size() {
    return this._stats.size;
  }

  /**
   * @return {Stats}
   */
  get stats() {
    return this._stats;
  }

  /**
   * @return {ExpireEntry}
   */
  get parent() {
    return this._parent;
  }

  /**
   * @return {Map<string, ExpireEntry>}
   */
  get children() {
    return this._children;
  }

  /**
   * @return {string[]}
   */
  get childrenList() {
    return [...this._children.keys()];
  }

  get hasChildren() {
    return this._children.size !== 0;
  }

  /**
   * @return {ExpireEntry[]}
   */
  get childrenValues() {
    return [...this._children.values()];
  }

  /**
   * @return {Promise<void>}
   */
  populate() {
    var _this = this;

    return _asyncToGenerator(function* () {
      try {
        _this._stats = yield _this._get_stats(_this._path);
      } catch (e) {
        console.warn(`error reading stats for ${_this._path}: ${e.message || e}`);
        return;
      }

      if (!_this.isDir) {
        return;
      }

      let list = [];
      try {
        list = yield _this._get_list(_this._path);
      } catch (e) {
        console.warn(`error reading dir listing for ${_this._path}: ${e.message || e}`);
        return;
      }

      const len = list.length;

      const entries = [];
      for (let i = 0; i < len; i++) {
        const name = list[i];
        if (name === '..' || name === '.') {
          continue;
        }

        const entry = new ExpireEntry({
          async: _this._async,
          path: path.join(_this.path, name),
          parent: _this
        });
        entries.push(entry);
        _this.children.set(entry.basename, entry);
      }

      yield Promise.all(entries.map(function (e) {
        return e.populate();
      }));
    })();
  }

  /**
   * @param {boolean=} keepEmptyParent
   * @param {boolean=} dry
   * @return {Promise<void>}
   */
  delete({ keepEmptyParent = true, dry = false } = {}) {
    var _this2 = this;

    return _asyncToGenerator(function* () {
      debug_entry('deleting entry', _this2.path);

      if (_this2.isDir) {
        yield Promise.all(_this2.childrenValues.map(function (child) {
          return child.delete({
            keepEmptyParent: true,
            dry
          });
        }));
        if (!keepEmptyParent) {

          try {
            (yield dry) ? console.log('del dir  ', _this2._path) : _this2._rm_dir(_this2._path);
          } catch (e) {
            console.warn(`error deleting dir ${_this2._path}: ${e.message || e}`);
            return;
          }
        }
      } else {
        try {
          (yield dry) ? console.log('del file ', _this2.path) : _this2._rm_file(_this2._path);
        } catch (e) {
          console.warn(`error deleting file ${_this2._path}: ${e.message || e}`);
          return;
        }
      }

      if (_this2.parent) {
        _this2.parent.children.delete(_this2.basename);

        if (!keepEmptyParent && _this2.parent.children.size === 0) {
          yield _this2.parent.delete({ keepEmptyParent, dry });
        }
      }
    })();
  }

  /**
   * @param {function(ExpireEntry):void}callback
   */
  traverse(callback) {
    const children = this.childrenValues;
    const len = children.length;

    for (let i = 0; i < len; i++) {
      const c = children[i];
      callback(c);

      if (c.isDir) {
        c.traverse(callback);
      }
    }
  }

  /**
   * @param {function(ExpireEntry):Promise<void>}callback
   * @return {Promise<void>}
   */
  traverseAsync(callback) {
    var _this3 = this;

    return _asyncToGenerator(function* () {
      const children = _this3.childrenValues;
      const len = children.length;

      for (let i = 0; i < len; i++) {
        const c = children[i];
        yield callback(c);

        if (c.isDir) {
          yield c.traverseAsync(callback);
        }
      }
    })();
  }

  /**
   * @return {ExpireEntry[]}
   */
  list() {
    const list = [];

    this.traverse(e => {
      list.push(e);
    });

    return list;
  }
}

class ExpireFS extends EventEmitter {

  /**
   * @param {String} folder
   * @param {RegExp|function(String,Stats):Boolean=} filter
   * @param {String=} [timeType='birthtime']
   * @param {Number=} [expire=Infinity] - milliseconds
   * @param {Number=} [pressure=1] - percentage of disk usage
   * @param {Number=} [interval=300000] - milliseconds
   * @param {Boolean=} [autoStart=true]
   * @param {Boolean=} [unsafe=false]
   * @param {Boolean=} [removeEmptyDirs=false]
   * @param {Boolean=} [removeCleanedDirs=true]
   * @param {Boolean=} [async=false]
   * @param {Boolean=} [dry=false] - dry run
   */
  constructor({
    folder,
    unsafe = false,
    timeType = 'birthtime',
    filter = /.*/,
    expire = Infinity,
    pressure = 1,
    interval = 5 * 60 * 1000,
    autoStart = true,
    removeEmptyDirs = false,
    removeCleanedDirs = true,
    async = true,
    dry = true
  }) {
    super();

    if (!folder) {
      throw new Error('folder should be specified');
    }
    this.folder = path.resolve(folder);
    if (!unsafe && this.folder.split(path.sep).length <= 2) {
      throw new Error('Cowardly refusing to watch folder ' + folder + ' as it is a root folder. ' + 'To override this behaviour, please set "unsafe" to be true');
    }

    this.timeType = timeType;
    if (!validTimeTypes.has(this.timeType)) {
      throw new Error('timeType should be one of ' + [...validTimeTypes].join(', '));
    }

    this.filter = filter;
    this.expire = expire;
    this.pressure = pressure;
    this.interval = interval;
    this.autoStart = autoStart;
    this.debug_expire = debug_expire;
    this.debug_pressure = debug_pressure;

    this.removeEmptyDirs = removeEmptyDirs;
    this.removeCleanedDirs = removeCleanedDirs;
    this.dry = dry;

    this._interval = null;

    if (this.autoStart) {
      this.start();
    }

    this._async = async;
  }

  /**
   * @return {Promise<ExpireEntry>}
   */
  list() {
    var _this4 = this;

    return _asyncToGenerator(function* () {
      const entry = new ExpireEntry({
        async: _this4._async,
        path: _this4.folder,
        parent: null
      });
      yield entry.populate();
      return entry;
    })();
  }

  /**
   * @param {String} path
   * @param {Stats} stats
   * @return {boolean}
   * @private
   */
  _shouldDelete(path, stats) {
    const time = stats[this.timeType];
    // if regex check match (false)
    if (this.filter instanceof RegExp && this.filter.test(path) === false) {
      return false;
    }
    // if function check output (falsy)
    if (typeof this.filter === 'function' && !this.filter(path, stats)) {
      return false;
    }
    // if now - chosen time < expire time
    if (Date.now() - time.getTime() < this.expire) {
      return false;
    }
    // delete it
    return true;
  }

  /**
   * @param {ExpireEntry} entry
   * @param {boolean} dry
   * @return {Promise<ExpireEntry[]>}
   * @private
   */
  _expire({ entry, dry }) {
    var _this5 = this;

    return _asyncToGenerator(function* () {
      const list = entry.list();
      const len = list.length;
      const deleted = [];

      for (let i = 0; i < len; i++) {
        const e = list[i];

        // remove empty dirs
        if (_this5.removeEmptyDirs && e.isDir && !e.hasChildren) {
          _this5.debug_expire('deleting empty dir', e.path);
          yield e.delete({ keepEmptyParent: !_this5.removeCleanedDirs, dry });
          deleted.push(e);
        }

        // if it's dir, continue
        if (e.isDir) {
          _this5.debug_expire('skipping dir', e.path);
          continue;
        }

        // remove file is necessary
        if (_this5._shouldDelete(e.path, e.stats)) {
          _this5.debug_expire('deleting file', e.path);
          yield e.delete({ keepEmptyParent: !_this5.removeCleanedDirs, dry });
          deleted.push(e);
        } else {
          _this5.debug_expire('keeping file', e.path);
        }
      }
      return deleted;
    })();
  }

  /**
   * @param {ExpireEntry} entry
   * @param {boolean} dry
   * @return {Promise<ExpireEntry[]>}
   * @private
   */
  _pressure({ entry, dry }) {
    var _this6 = this;

    return _asyncToGenerator(function* () {
      const deleted = [];

      const list = entry.list();
      const disk = (yield _this6._async) ? diskusage.check(entry.path) : diskusage.checkSync(entry.path);

      const usagePerc = 1 - disk.available / disk.total;

      if (usagePerc < _this6.pressure) {
        return;
      }

      const shouldBe = disk.total * _this6.pressure;
      let toFree = shouldBe - disk.available;

      debug_pressure(`disk usage is ${(usagePerc * 100).toFixed(2)}%`);
      debug_pressure(`need to free ${pretty_size(toFree)}`);

      // newest to oldest
      list.sort(function (a, b) {
        return b.getTime(_this6.timeType) - a.getTime(_this6.timeType);
      });

      while (list.length && toFree > 0) {
        const item = list.pop();
        if (item.isDir) {
          continue;
        }

        toFree -= item.size;
        yield item.delete({ dry, keepEmptyParent: !_this6.removeCleanedDirs });
        deleted.push(item);
        debug_pressure(`freed ${pretty_size(item.size)} | left ${pretty_size(toFree)}`);
      }
      return deleted;
    })();
  }

  /**
   * @param {boolean=}dry
   * @return {Promise<ExpireEntry[]>}
   */
  clean({ dry = this.dry } = {}) {
    var _this7 = this;

    return _asyncToGenerator(function* () {
      const entry = yield _this7.list();
      const deleted = [];
      deleted.push(...(yield _this7._expire({ dry, entry })));
      deleted.push(...(yield _this7._pressure({ dry, entry })));
      _this7.emit('clean', deleted);
      return deleted;
    })();
  }

  /**
   * @return {boolean}
   */
  stop() {
    if (!this._interval) {
      return false; // not started
    }
    clearInterval(this._interval);
    this._interval = null;
    return true;
  }

  /**
   * @return {boolean}
   */
  start() {
    var _this8 = this;

    if (this._interval) {
      return false; // already started
    }
    this._interval = setInterval(_asyncToGenerator(function* () {
      try {
        yield _this8.clean();
      } catch (e) {
        _this8.emit('error', e);
      }
    }), this.interval);
    return true;
  }
}

/**
 *
 * @type {{access_time: string, modify_time: string, creation_time: string, birth_time: string}}
 */
ExpireFS.TimeType = {
  access_time: 'atime',
  modify_time: 'mtime',
  creation_time: 'ctime',
  birth_time: 'birthtime'
};

module.exports = ExpireFS;
//# sourceMappingURL=index.js.map