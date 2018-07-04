# ExpireFS

_Easily give your files a max lifetime._

## Install
```
npm i expire-fs
```

## Options
- `{String}` folder - folder to watch
- `{RegExp|function(String,Stats):Boolean=}` filter=`/.*/` - files to filter
- `{String=}` timeType=`'birthtime'` - type of time
    - possible values `['atime', 'mtime', 'ctime', 'birthtime']`
- `{Number=}` expire=`Infinity` - time in milliseconds of max file life
- `{Number=}` interval=`300000` - time in milliseconds between searching cycles
- `{Boolean=}` recursive=`true` - drill down recursevly in folders
- `{Boolean=}` autoStart=`true` - auto start the timer
- `{Boolean=}` removeEmptyDirs=`false` - remove any dir that is empty
- `{Boolean=}` removeCleanedDirs=`true` - remove dir only if it was cleaned by expire-fs

## Methods

### `ExpireFS.clean(void):Promise<ExpireFolderChain[]>`
Method that will run the clean routine on demand

### `ExpireFS.start(void):Boolean`
Method to start the timer. If already started, request is ignored.

### `ExpireFS.stop(void):Boolean`
Method to stop the timer. If already stopped, request is ignored.

## Events

### `ExpireFS#clean(ExpireFolderChain[])`
Event fired when a clear cycle has finished

## JSDocs
```js
  /**
   * @typedef {Object} ExpireFolderFile
   * @property {String} path
   * @property {Boolean} deleted
   * @property {Boolean} file
   */

  /**
   * @typedef {Object} ExpireFolderChain
   * @property {String} path
   * @property {Boolean} folder
   * @property {Array.<ExpireFolderFile|ExpireFolderChain>}} list
   */
```

## Example
```js

const ExpireFs = require('expire-fs');

const ex = new ExpireFs({
  folder: '/tmp/upload_segments',
  filter: /\.segment\.\d+$/,
  recursive: false,
  expire: 24 * 3600 * 1000 // 1 day
});

// event fired one a .clear cycle is completed
ex.on('clean', (data) => console.log(data);

// fire a manual clean
ex.clean().then((data) => console.log(data), console.error);
```
