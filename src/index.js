const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const readdirAsync = dirname => new Promise((res, rej) => fs.readdir(dirname, (e, l) => e ? rej(e) : res(l)));
const unlinkAsync = filename => new Promise((res, rej) => fs.unlink(filename, e => e ? rej(e) : res()));
const statsAsync = filename => new Promise((res, rej) => fs.stat(filename, (e, s) => e ? rej(e) : res(s)));
const rmdirAsync = filename => new Promise((res, rej) => fs.rmdir(filename, e => e ? rej(e) : res()));

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
                removeEmptyDirs = true
              }) {
    super();

    if (!folder) {
      throw new Error('folder should be specified');
    }
    this.folder = path.resolve(folder);
    if (!unsafe && this.folder.split(path.sep).length <= 2) {
      throw new Error(
        'Cowardly refusing to watch folder ' + folder + ' as it is a root folder. ' +
        'To override this behaviour, please set "unsafe" to be true'
      );
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

    this._interval = null;

    if (this.autoStart) {
      this.start();
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
  async _clean(dir) {

    const list = await readdirAsync(dir);

    return await Promise.all(list
      .map(item => path.join(dir, item))
      .map(async path => {
        const stats = await statsAsync(path);

        if (this.recursive && stats.isDirectory() && path !== '.' && path !== '..') {
          const data = await this._clean(path).then(x => ({ path, list: x, folder: true })); // recursive on next dir
          if (this.removeEmptyDirs && (await readdirAsync(path)).length === 0) {
            await rmdirAsync(path);
          }
          return data;
        }

        if (!stats.isDirectory() && this._shouldDelete(path, stats) === true) {
          return await unlinkAsync(path).then(x => ({ path, deleted: true, file: true })); // delete file
        }

        return { path, deleted: false }
      })
    );
  }

  /**
   * @return {PromiseLike<ExpireFSFolderChain[]> | Promise<ExpireFSFolderChain[]>}
   */
  async clean() {
    const data = await this._clean(this.folder)
    this.emit('clean', data);
    return data;
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
    if (this._interval) {
      return false; // already started
    }
    this._interval = setInterval(this.clean.bind(this), this.interval);
    return true;
  }
}

module.exports = ExpireFS;
