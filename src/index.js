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

const pretty_size = (size) => {
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
    try {
      this._stats = await this._get_stats(this._path);
    } catch (e) {
      console.warn(`error reading stats for ${this._path}: ${e.message || e}`);
      return;
    }

    if (!this.isDir) {
      return;
    }

    let list = [];
    try {
      list = await this._get_list(this._path);
    } catch (e) {
      console.warn(`error reading dir listing for ${this._path}: ${e.message || e}`);
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
    debug_entry('deleting entry', this.path);

    if (this.isDir) {
      await Promise.all(
        this.childrenValues.map(child => child.delete({
          keepEmptyParent: true,
          dry
        })));
      if (!keepEmptyParent) {

        try {
          await (
            dry ?
              console.log('del dir  ', this._path) :
              this._rm_dir(this._path)
          );
        } catch (e) {
          console.warn(`error deleting dir ${this._path}: ${e.message || e}`);
          return;
        }
      }
    } else {
      try {
        await (
          dry ?
            console.log('del file ', this.path) :
            this._rm_file(this._path)
        );
      } catch (e) {
        console.warn(`error deleting file ${this._path}: ${e.message || e}`);
        return;
      }
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
      throw new Error(
        'Cowardly refusing to watch folder ' + folder + ' as it is a root folder. ' +
        'To override this behaviour, please set "unsafe" to be true'
      );
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

  /**
   * @param {ExpireEntry} entry
   * @param {boolean} dry
   * @return {Promise<ExpireEntry[]>}
   * @private
   */
  async _expire({ entry, dry }) {
    const list = entry.list();
    const len = list.length;
    const deleted = [];

    for (let i = 0; i < len; i++) {
      const e = list[i];

      // remove empty dirs
      if (this.removeEmptyDirs && e.isDir && !e.hasChildren) {
        this.debug_expire('deleting empty dir', e.path);
        await e.delete({ keepEmptyParent: !this.removeCleanedDirs, dry });
        deleted.push(e);
      }

      // if it's dir, continue
      if (e.isDir) {
        this.debug_expire('skipping dir', e.path);
        continue;
      }

      // remove file is necessary
      if (this._shouldDelete(e.path, e.stats)) {
        this.debug_expire('deleting file', e.path);
        await e.delete({ keepEmptyParent: !this.removeCleanedDirs, dry });
        deleted.push(e);
      } else {
        this.debug_expire('keeping file', e.path);
      }
    }
    return deleted;
  }

  /**
   * @param {ExpireEntry} entry
   * @param {boolean} dry
   * @return {Promise<ExpireEntry[]>}
   * @private
   */
  async _pressure({ entry, dry }) {
    const deleted = [];

    const list = entry.list();
    const disk = await (
      this._async ?
        diskusage.check(entry.path) :
        diskusage.checkSync(entry.path)
    );

    const usagePerc = 1 - (disk.available / disk.total);

    if (usagePerc < this.pressure) {
      return [];
    }

    const shouldBe = disk.total * this.pressure;
    let toFree = (disk.total - disk.available) - shouldBe;

    debug_pressure(`disk usage is ${(usagePerc * 100).toFixed(2)}%`);
    debug_pressure(`need to free ${pretty_size(toFree)}`);

    // newest to oldest
    list.sort((a, b) => b.getTime(this.timeType) - a.getTime(this.timeType));

    while (list.length && toFree > 0) {
      const item = list.pop();
      if (item.isDir) {
        continue;
      }

      toFree -= item.size;
      await item.delete({ dry, keepEmptyParent: !this.removeCleanedDirs });
      deleted.push(item);
      debug_pressure(`freed ${pretty_size(item.size)} | left ${pretty_size(toFree)}`);
    }
    return deleted;
  }

  /**
   * @param {boolean=}dry
   * @return {Promise<ExpireEntry[]>}
   */
  async clean({ dry = this.dry } = {}) {
    const entry = await this.list();
    const deleted = [];
    deleted.push(...await this._expire({ dry, entry }));
    deleted.push(...await this._pressure({ dry, entry }));
    this.emit('clean', deleted);
    return deleted;
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
