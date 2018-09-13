'use strict';

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const readdirAsync = dirname => new Promise((res, rej) => fs.readdir(dirname, (e, l) => e ? rej(e) : res(l)));
const unlinkAsync = filename => new Promise((res, rej) => fs.unlink(filename, e => e ? rej(e) : res()));
const statsAsync = filename => new Promise((res, rej) => fs.stat(filename, (e, s) => e ? rej(e) : res(s)));
const rmdirAsync = filename => new Promise((res, rej) => fs.rmdir(filename, e => e ? rej(e) : res()));

const readdir = filename => fs.readdirSync(filename);
const unlink = filename => fs.unlinkSync(filename);
const stats = filename => fs.statSync(filename);
const rmdir = filename => fs.rmdirSync(filename);

const ignoreENOENT = (() => {
  var _ref = _asyncToGenerator(function* (fn, ...args) {
    try {
      return yield fn(...args);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return undefined;
      }
      throw e;
    }
  });

  return function ignoreENOENT(_x) {
    return _ref.apply(this, arguments);
  };
})();

const validTimeTypes = ['atime', 'mtime', 'ctime', 'birthtime'];

class ExpireFS extends EventEmitter {

  /**
   * @param options
   * @param {String} options.folder
   * @param {RegExp|function(String,Stats):Boolean=} options.filter
   * @param {String=} [options.timeType='birthtime']
   * @param {Number=} [options.expire=Infinity] - milliseconds
   * @param {Number=} [options.interval=300000] - milliseconds
   * @param {Boolean=} [options.recursive=true]
   * @param {Boolean=} [options.autoStart=true]
   * @param {Boolean=} [options.unsafe=false]
   * @param {Boolean=} [options.removeEmptyDirs=false]
   */
  constructor({
    folder,
    unsafe = false,
    timeType = 'birthtime',
    filter = /.*/,
    expire = Infinity,
    interval = 5 * 60 * 1000,
    recursive = true,
    autoStart = true,
    removeEmptyDirs = false,
    removeCleanedDirs = true,
    async = true
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
    if (!~validTimeTypes.indexOf(this.timeType)) {
      throw new Error('timeType should be one of ' + validTimeTypes.join(', '));
    }

    this.filter = filter;
    this.expire = expire;

    this.interval = interval;
    this.recursive = recursive;
    this.autoStart = autoStart;

    this.removeEmptyDirs = removeEmptyDirs;
    this.removeCleanedDirs = removeCleanedDirs;

    this._interval = null;

    if (this.autoStart) {
      this.start();
    }

    this._readdir = readdir;
    this._unlink = unlink;
    this._stats = stats;
    this._rmdir = rmdir;
    if (async) {
      this._readdir = readdirAsync;
      this._unlink = unlinkAsync;
      this._stats = statsAsync;
      this._rmdir = rmdirAsync;
    }
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
   * @typedef {Object} ExpireFSFolderFile
   * @property {String} path
   * @property {Boolean} deleted
   * @property {Boolean} file
   */

  /**
   * @typedef {Object} ExpireFSFolderChain
   * @property {String} path
   * @property {Boolean} folder
   * @property {Array.<ExpireFSFolderFile|ExpireFSFolderChain>}} list
   */

  /**
   * @param {String} dir
   * @return {PromiseLike<ExpireFSFolderChain[]> | Promise<ExpireFSFolderChain[]>}
   * @private
   */
  _clean(dir) {
    var _this = this;

    return _asyncToGenerator(function* () {

      const list = yield _this._readdir(dir);

      return yield Promise.all(list.map(function (item) {
        return path.join(dir, item);
      }).map((() => {
        var _ref2 = _asyncToGenerator(function* (path) {
          const stats = yield ignoreENOENT(_this._stats, path);
          if (!stats) {
            // it's been already deleted
            return { path, deleted: false };
          }

          if (_this.recursive && stats.isDirectory() && path !== '.' && path !== '..') {
            const data = yield _this._clean(path).then(function (x) {
              return { path, list: x, folder: true };
            }); // recursive on next dir

            // if dir is empty
            if ((yield _this._readdir(path)).length === 0) {

              // and if we want to delete empty dirs
              if (_this.removeEmptyDirs) {
                // delete dir
                yield _this._rmdir(path);
              }
              // and if we want to delete only dirs that have been cleaned up
              else if (_this.removeCleanedDirs && data.list.length > 0) {
                  // delete dir
                  yield _this._rmdir(path);
                }
            }
            return data;
          }

          if (!stats.isDirectory() && _this._shouldDelete(path, stats) === true) {
            yield _this._unlink(path); // delete file
            return { path, deleted: true, file: true };
          }

          return { path, deleted: false };
        });

        return function (_x2) {
          return _ref2.apply(this, arguments);
        };
      })()));
    })();
  }

  /**
   * @return {PromiseLike<ExpireFSFolderChain[]> | Promise<ExpireFSFolderChain[]>}
   */
  clean() {
    var _this2 = this;

    return _asyncToGenerator(function* () {
      const data = yield _this2._clean(_this2.folder);
      _this2.emit('clean', data);
      return data;
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
    var _this3 = this;

    if (this._interval) {
      return false; // already started
    }
    this._interval = setInterval(_asyncToGenerator(function* () {
      try {
        yield _this3.clean();
      } catch (e) {
        _this3.emit('error', e);
      }
    }), this.interval);
    return true;
  }
}

module.exports = ExpireFS;
//# sourceMappingURL=index.js.map