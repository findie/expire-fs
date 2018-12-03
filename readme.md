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
- `{Number=}` pressure=`1.0` - percentage of maximum disk usage before starting to delete files before they expire
- `{Number=}` interval=`300000` - time in milliseconds between searching cycles
- `{Boolean=}` autoStart=`true` - auto start the timer
- `{Boolean=}` removeEmptyDirs=`false` - remove any dir that is empty
- `{Boolean=}` removeCleanedDirs=`true` - remove dir only if it was cleaned by expire-fs

## Methods

### `ExpireFS.clean(void):Promise<void>`
Method that will run the clean routine on demand

### `ExpireFS.start(void):Boolean`
Method to start the timer. If already started, request is ignored.

### `ExpireFS.stop(void):Boolean`
Method to stop the timer. If already stopped, request is ignored.

## Events

### `ExpireFS#clean()`
Event fired when a clear cycle has finished

### `ExpireFS#error(Error)`
Event fired when an error occurs during a schedules clear cycle.

## Example
```js

const ExpireFs = require('expire-fs');

const ex = new ExpireFs({
  // clean folder
  folder: '/tmp/upload_segments',
  // using filter
  filter: /\.segment\.\d+$/,
  // start deleting oldest files if disk usage is above 80%
  pressure: 0.8,
  // delete files after one day
  expire: 24 * 3600 * 1000
});

// event fired one a .clear cycle is completed
ex.on('clean', () => console.log('done cleanning');

// fire a manual clean
ex.clean().then(() => console.log('done'), console.error);
```
