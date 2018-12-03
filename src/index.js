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

const ignoreENOENT = async (fn, ...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
};

const validTimeTypes = ['atime', 'mtime', 'ctime', 'birthtime'];

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
    this._children = new Map;

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
  async populate() {
    this._stats = await this._get_stats(this._path);

    if (!this.isDir) {
      return;
    }

    const list = await this._get_list(this._path);
    const len = list.length;

    const entries = [];
    for (let i = 0; i < len; i++) {
      const name = list[i];
      if (name === '..' || name === '.') {
        continue;
      }

      const entry = new ExpireEntry({
        async: this._async,
        path: path.join(this.path, name),
        parent: this
      });
      entries.push(entry);
      this.children.set(entry.basename, entry);
    }

    await Promise.all(entries.map(e => e.populate()));
  }

  /**
   * @param {boolean=} keepEmptyParent
   * @param {boolean=} dry
   * @return {Promise<void>}
   */
  async delete({ keepEmptyParent = true, dry = false } = {}) {
    if (this.isDir) {
      await Promise.all(
        this.childrenValues.map(child => child.delete({
          keepEmptyParent: true,
          dry
        })));
      if (!keepEmptyParent) {
        await dry ?
          console.log('del dir  ', this._path) :
          this._rm_dir(this._path);
      }
    } else {
      await dry ?
        console.log('del file ', this.path) :
        this._rm_file(this._path);
    }

    if (this.parent) {
      this.parent.children.delete(this.basename);

      if (!keepEmptyParent && this.parent.children.size === 0) {
        await this.parent.delete({ keepEmptyParent, dry });
      }
    }
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
  async traverseAsync(callback) {
    const children = this.childrenValues;
    const len = children.length;

    for (let i = 0; i < len; i++) {
      const c = children[i];
      await callback(c);

      if (c.isDir) {
        await c.traverseAsync(callback);
      }
    }
  }

  /**
   * @return {ExpireEntry[]}
   */
  list() {
    const list = [];

    this.traverse((e) => {
      list.push(e)
    });

    return list;
  }
}


class ExpireFS extends EventEmitter {

  /**
   * @param options
   * @param {String} options.folder
   * @param {RegExp|function(String,Stats):Boolean=} options.filter
   * @param {String=} [options.timeType='birthtime']
   * @param {Number=} [options.expire=Infinity] - milliseconds
   * @param {Number=} [options.interval=300000] - milliseconds
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
    this.autoStart = autoStart;

    this.removeEmptyDirs = removeEmptyDirs;
    this.removeCleanedDirs = removeCleanedDirs;
    this.dry = dry;

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
    this._async = async;
  }

  /**
   * @return {Promise<ExpireEntry>}
   */
  async list() {
    const entry = new ExpireEntry({
      async: this._async,
      path: this.folder,
      parent: null
    });
    await entry.populate();
    return entry;
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


  async clean({ dry = this.dry } = {}) {
    const entry = await this.list();
    const list = entry.list();
    const len = list.length;
    for (let i = 0; i < len; i++) {
      const e = list[i];

      // remove empty dirs
      if (this.removeEmptyDirs && e.isDir && !e.hasChildren) {
        await e.delete({ keepEmptyParent: !this.removeCleanedDirs, dry });
      }

      // if it's dir, continue
      if (e.isDir) {
        continue;
      }

      // remove file is necessary
      if (this._shouldDelete(e.path, e.stats)) {
        await e.delete({ keepEmptyParent: !this.removeCleanedDirs, dry });
      }
    }
    this.emit('clean');
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
    this._interval = setInterval(async () => {
      try {
        await this.clean();
      } catch (e) {
        this.emit('error', e);
      }
    }, this.interval);
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
