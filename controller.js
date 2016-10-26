/**
 *      application.controller
 *
 *      Controls Adapter-Processes
 *
 *      Copyright 2013-2016 bluefox <dogafox@gmail.com>, hobbyquaker <hq@ccu.io>
 *
 */

var schedule    = require('node-schedule');
var os          = require('os');
var fs          = require('fs');
var cp          = require('child_process');
var ioPackage   = require(__dirname + '/io-package.json');
var tools       = require(__dirname + '/lib/tools');
var version     = ioPackage.common.version;
var adapterDir  = __dirname.replace(/\\/g, '/');
var zipFiles;

// Change version in io-package.json and start grunt task to modify the version
var title = tools.appName + '.js-controller';
process.title = title;

var Objects;
var States;

var semver;
var logger;
var isDaemon                = false;
var callbackId              = 1;
var callbacks               = {};
var hostname                = tools.getHostName();
var logList                 = [];
var detectIpsCount          = 0;
var disconnectTimeout       = null;
var connected               = null; // not false, because want to detect first connection
var ipArr                   = [];
var lastCalculationOfIps    = null;
var errorCodes              = [
    'OK', // 0
    '', // 1
    'Adapter has invalid config or no config found', // 2
    'Adapter disabled or invalid config', // 3
    'invalid config: no _id found', // 4
    'invalid config', // 5
    'uncaught exception', // 6
    'Adapter already running', // 7
    'node.js: Cannot find module', // 8
    '', // 9
    'Cannot find start file of adapter' // 10
];
var procs                   = {};
var subscribe               = {};
var states                  = null;
var objects                 = null;
var storeTimer              = null;
var isStopping              = null;
var allInstancesStopped     = true;
var stopTimeout             = 10000;
var uncaughtExceptionCount  = 0;
var installQueue            = [];
var started                 = false;

var config;
if (!fs.existsSync(tools.getConfigFileName())) {
    if (process.argv.indexOf('start') !== -1) {
        isDaemon = true;
        logger = require(__dirname + '/lib/logger')('info', [tools.appName], true);
    } else {
        logger = require(__dirname + '/lib/logger')('info', [tools.appName]);
    }
    logger.error('host.' + hostname + ' conf/' + tools.appName + '.json missing - call node ' + tools.appName + '.js setup');
    process.exit(1);
} else {
    config = JSON.parse(fs.readFileSync(tools.getConfigFileName()));
    if (!config.states)  config.states  = {type: 'file'};
    if (!config.objects) config.objects = {type: 'file'};
}

// Get "objects" object
// If "file" and on the local machine
if (config.objects.type === 'file' && (!config.objects.host || config.objects.host === 'localhost' || config.objects.host === '127.0.0.1')) {
    Objects = require(__dirname + '/lib/objects/objectsInMemServer');
} else {
    Objects = require(__dirname + '/lib/objects');
}

// Get "states" object
if (config.states.type === 'file' && (!config.objects.host || config.objects.host === 'localhost' || config.objects.host === '127.0.0.1')) {
    States  = require(__dirname + '/lib/states/statesInMemServer');
} else {
    States  = require(__dirname + '/lib/states');
}

// Detect if outputs to console are forced. By default they are disabled and redirected to log file
if (config.log.noStdout && process.argv && (process.argv.indexOf('--console') !== -1 || process.argv.indexOf('--logs') !== -1)) {
    config.log.noStdout = false;
}

// Detect if controller runs as a linux-daemon
if (process.argv.indexOf('start') !== -1) {
    isDaemon = true;
    config.log.noStdout = true;
    logger = require(__dirname + '/lib/logger.js')(config.log);
} else {
    logger = require(__dirname + '/lib/logger.js')(config.log);
}

// Delete all log files older than x das
logger.activateDateChecker(true, config.log.maxDays);

// If installed as npm module
adapterDir = adapterDir.split('/');
if (adapterDir.pop() === 'node_modules') {
    adapterDir = adapterDir.join('/');
} else {
    adapterDir = __dirname.replace(/\\/g, '/') + '/node_modules';
}

// get the list of IP addresses of this host
function getIPs() {
    if (!lastCalculationOfIps || new Date().getTime() - lastCalculationOfIps > 10000) {
        var ifaces = os.networkInterfaces();
        lastCalculationOfIps = new Date().getTime();
        ipArr = [];
        for (var dev in ifaces) {
            if (!ifaces.hasOwnProperty(dev)) continue;

            /*jshint loopfunc:true */
            ifaces[dev].forEach(function (details) {
                //noinspection JSUnresolvedVariable
                if (!details.internal) ipArr.push(details.address);
            });
        }
    }

    return ipArr;
}

// If some message from logger
logger.on('logging', function (transport, level, msg/*, meta*/) {
    // Send to all adapter, that required logs
    for (var i = 0; i < logList.length; i++) {
        states.pushLog(logList[i], {message: msg, severity: level, from: hostname, ts: (new Date()).getTime()});
    }
});

// subscribe or unsubscribe loggers
function logRedirect(isActive, id) {
    if (isActive) {
        if (logList.indexOf(id) === -1) logList.push(id);
    } else {
        var pos = logList.indexOf(id);
        if (pos !== -1) logList.splice(pos, 1);
    }
}

logger.info('host.' + hostname + ' ' + tools.appName + '.js-controller version ' + version + ' ' + ioPackage.common.name + ' starting');
logger.info('host.' + hostname + ' Copyright (c) 2014-2016 bluefox, hobbyquaker');
logger.info('host.' + hostname + ' hostname: ' + hostname + ', node: ' + process.version);
logger.info('host.' + hostname + ' ip addresses: ' + getIPs().join(' '));

// create package.json for npm >= 3.x if not exists
if (__dirname.replace(/\\/g, '/').toLowerCase().indexOf('/node_modules/' + title.toLowerCase()) !== -1) {
    try {
        if (!fs.existsSync(__dirname + '/../../package.json')) {
            fs.writeFileSync(__dirname + '/../../package.json', JSON.stringify({
                name: 'iobroker.core',
                private: true
            }, null, 2));
        }
    } catch (e) {
        console.error('Cannot create "' + __dirname + '/../../package.json": ' + e);
    }
}

function createStates() {
    return new States({
        connection: config.states,
        logger: logger,
        hostname: hostname,
        change: function (id, state) {
            if (!id) {
                logger.error('host.' + hostname + ' change event with no ID: ' + JSON.stringify(state));
                return;
            }
            // If some log transporter activated or deactivated
            if (id.match(/.logging$/)) {
                logRedirect(state ? state.val : false, id.substring(0, id.length - '.logging'.length));
            } else
            // If this is messagebox
            if (id === 'messagebox.system.host.' + hostname) {
                // Read it from fifo list
                states.delMessage('system.host.' + hostname, state._id);
                var obj = state;
                if (obj) {
                    // If callback stored for this request
                    if (obj.callback &&
                        obj.callback.ack &&
                        obj.callback.id &&
                        callbacks &&
                        callbacks['_' + obj.callback.id]) {
                        // Call callback function
                        if (callbacks['_' + obj.callback.id].cb) {
                            callbacks['_' + obj.callback.id].cb(obj.message);
                            delete callbacks['_' + obj.callback.id];
                        }

                        // delete too old callbacks IDs
                        var now = (new Date()).getTime();
                        for (var _id in callbacks) {
                            if (!callbacks.hasOwnProperty(_id)) continue;
                            if (now - callbacks[_id].time > 3600000) delete callbacks[_id];
                        }
                    } else {
                        processMessage(obj);
                    }
                }
            } else
            // If this system.adapter.NAME.0.alive
            if (id.match(/^system.adapter.[^.]+\.\d+\.alive$/)) {
                if (state && !state.ack) {
                    var enabled = state.val;
                    setTimeout(function () {
                        objects.getObject(id.substring(0, id.length - '.alive'.length), function (err, obj) {
                            if (err) logger.error('Cannot read object: '  + err);
                            if (obj && obj.common) {
                                // IF adapter enabled => disable it
                                if ((obj.common.enabled && !enabled) || (!obj.common.enabled && enabled)) {
                                    obj.common.enabled = !!enabled;

                                    setTimeout(function () {
                                        objects.setObject(obj._id, obj);
                                    }, 0);
                                }
                            }
                        });
                    }, 0);
                }
            } else
            if (subscribe[id]) {
                for (var i = 0; i < subscribe[id].length; i++) {
                    // wake up adapter
                    if (procs[subscribe[id][i]]) {
                        console.log('Wake up ' + id + ' ' + JSON.stringify(state));
                        startInstance(subscribe[id][i], true);
                    } else {
                        logger.warn('host.' + hostname + ' controller Adapter subscribed on ' + id + ' does not exist!');
                    }
                }
            } else
            // Monitor activity of the adapter and restart it if stopped
            if (!isStopping && id.substring(id.length - '.alive'.length) === '.alive') {
                var adapter = id.substring(0, id.length - '.alive'.length);
                if (procs[adapter] &&
                    !procs[adapter].stopping &&
                    !procs[adapter].process &&
                    procs[adapter].config &&
                    procs[adapter].config.common.enabled &&
                    procs[adapter].config.common.mode === 'daemon') {
                    startInstance(adapter, false);
                }
            }
        },
        connected: function () {
            if (states.clearAllLogs)     states.clearAllLogs();
            if (states.clearAllMessages) states.clearAllMessages();
        }
    });
}

// create states object
states = createStates();

// Subscribe for all logging objects
states.subscribe('*.logging');

// Subscribe for all logging objects
states.subscribe('system.adapter.*.alive');

// Read current state of all log subscriber
states.getKeys('*.logging', function (err, keys) {
    if (keys && keys.length) {
        states.getStates(keys, function (err, obj) {
            if (obj) {
                for (var i = 0; i < keys.length; i++) {
                    // We can JSON.parse, but index is 16x faster
                    if (obj[i]) {
                        if (typeof obj[i] === 'string' && (obj[i].indexOf('"val":true') !== -1 || obj[i].indexOf('"val":"true"') !== -1)) {
                            logRedirect(true, keys[i].substring(0, keys[i].length - '.logging'.length).replace(/^io\./, ''));
                        } else if (typeof obj[i] === 'object' && (obj[i].val === true || obj[i].val === 'true')) {
                            logRedirect(true, keys[i].substring(0, keys[i].length - '.logging'.length).replace(/^io\./, ''));
                        }
                    }
                }
            }
        });
    }
});

// create "objects" object
function createObjects() {
    return new Objects({
        connection: config.objects,
        logger: logger,
        hostname: hostname,
        connected: function (type) {
            // stop disconnect timeout
            if (disconnectTimeout) {
                clearTimeout(disconnectTimeout);
                disconnectTimeout = null;
            }

            if (!connected) {
                logger.info('host.' + hostname + ' ' + type + ' connected');

                if (connected === null) {
                    connected = true;
                    if (!isStopping) {
                        // Do not start if we still stopping the instances
                        checkHost(type, function () {
                            setMeta();
                            started = true;
                            getInstances();
                            startAliveInterval();
                            initMessageQueue();
                        });
                    }
                } else {
                    connected = true;
                    started   = true;

                    // Do not start if we still stopping the instances
                    if (!isStopping) {
                        getInstances();
                        startAliveInterval();
                        initMessageQueue();
                    }
                }
            }
        },
        disconnected: function (/*error*/) {
            if (disconnectTimeout) clearTimeout(disconnectTimeout);
            disconnectTimeout = setTimeout(function () {
                connected = false;
                disconnectTimeout = null;
                logger.warn('host.' + hostname + ' Slave controller detected disconnection. Stop all instances.');
                stopInstances(true, function () {
                    // if during stopping the DB has connection again
                    if (connected && !isStopping) {
                        getInstances();
                        startAliveInterval();
                        initMessageQueue();
                    }
                });
            }, config.objects.connectTimeout || 2000);

        },
        change: function (id, obj) {
            if (!started || !id.match(/^system\.adapter\.[a-zA-Z0-9-_]+\.[0-9]+$/)) return;
            logger.info('host.' + hostname + ' object change ' + id);
            try{
                if (procs[id]) {
                    // known adapter
                    if (!obj) {
                        procs[id].config.common.enabled = false;
                        procs[id].config.common.host    = null;
                        procs[id].config.deleted        = true;
                        logger.info('host.' + hostname + ' object deleted ' + id);
                    } else {
                        if (procs[id].config.common.enabled && !obj.common.enabled) logger.info('host.' + hostname + ' "' + id + '" disabled');
                        if (!procs[id].config.common.enabled && obj.common.enabled) logger.info('host.' + hostname + ' "' + id + '" enabled');
                        procs[id].config = obj;
                    }
                    if (procs[id].process || procs[id].config.common.mode === 'schedule' || procs[id].config.common.mode === 'subscribe') {
                        stopInstance(id, function () {
                            var _ipArr = getIPs();

                            if (_ipArr.indexOf(procs[id].config.common.host) !== -1 || procs[id].config.common.host === hostname) {
                                if (procs[id].config.common.enabled) {
                                    setTimeout(function (_id) {
                                        startInstance(_id);
                                    }, 2500, id);
                                }
                            } else {
                                delete procs[id];
                            }
                        });
                    } else {
                        var __ipArr = getIPs();
                        if (procs[id].config && (__ipArr.indexOf(procs[id].config.common.host) !== -1 || procs[id].config.common.host === hostname)) {
                            if (procs[id].config.common.enabled) startInstance(id);
                        } else {
                            delete procs[id];
                        }
                    }

                } else if (obj && obj.common) {
                    var _ipArr = getIPs();
                    // new adapter
                    if (_ipArr.indexOf(obj.common.host) !== -1 || obj.common.host === hostname) {
                        procs[id] = {config: obj};
                        if (procs[id].config.common.enabled) startInstance(id);
                    }
                }
            } catch (err) {
                logger.error('cannot process: ' + id);
            }
        }
    });
}
objects = createObjects ();

objects.subscribe('system.adapter.*');

function startAliveInterval() {
    reportStatus();
    setInterval(function () {
        reportStatus();
    }, 15000);
}

function reportStatus() {
    var id = 'system.host.' + hostname;
    states.setState(id + '.alive',   {val: true, ack: true, expire: 30, from: id});
    states.setState(id + '.load',    {val: parseFloat(os.loadavg()[0].toFixed(2)), ack: true, from: id});
    states.setState(id + '.mem',     {val: Math.round(100 * os.freemem() / os.totalmem()), ack: true, from: id});
    var mem = process.memoryUsage();
    //noinspection JSUnresolvedVariable
    states.setState(id + '.memRss', {val: parseFloat((mem.rss / 1048576/* 1MB */).toFixed(2)), ack: true, from: id});
    //noinspection JSUnresolvedVariable
    states.setState(id + '.memHeapTotal', {val: parseFloat((mem.heapTotal / 1048576/* 1MB */).toFixed(2)), ack: true, from: id});
    //noinspection JSUnresolvedVariable
    states.setState(id + '.memHeapUsed', {val: parseFloat((mem.heapUsed / 1048576/* 1MB */).toFixed(2)), ack: true, from: id});
    // Under windows toFixed returns string ?
    states.setState(id + '.uptime', {val: parseInt(process.uptime().toFixed(), 10), ack: true, from: id});
    states.setState(id + '.freemem', {val: Math.round(os.freemem() / 1048576/* 1MB */), ack: true, from: id});
}

function changeHost(objs, oldHostname, newHostname, callback) {
    if (!objs || !objs.length) {
        if (callback) callback();
    } else {
        var row = objs.shift();
        if (row && row.value && row.value.common && row.value.common.host === oldHostname) {
            obj = row.value;
            obj.common.host = newHostname;
            logger.info('Reassign instance ' + obj._id.substring('system.adapter.'.length) + ' from ' + oldHostname + ' to ' + newHostname);
            objects.setObject(obj._id, obj, function (err) {
                setTimeout(function () {
                    changeHost(objs, oldHostname, newHostname, callback);
                }, 0)
            });
        } else {
            setTimeout(function () {
                changeHost(objs, oldHostname, newHostname, callback);
            }, 0)
        }
    }
}

function delObjects(objs, callback) {
    if (!objs || !objs.length) {
        if (callback) callback();
    } else {
        var row = objs.shift();
        if (row && row.id) {
            logger.delete('Delete state "' + row.id + '"');
            objects.delObject(row.id, function (err) {
                setTimeout(function () {
                    delObjects(objs, callback);
                }, 0);
            });
        } else {
            setTimeout(function () {
                delObjects(objs, callback);
            }, 0);
        }
    }
}
/**
 * try to check host in objects
 * <p>
 * This function tries to find all hosts in the objects and if
 * only one host found and it is not actual host, change the
 * host name to new one.
 * <p>
 *
 * @return none
 */
function checkHost(type, callback) {
    if (type === 'InMemoryDB') {
        objects.getObjectView('system', 'host', {}, function (_err, doc) {
            if (!_err && doc && doc.rows &&
                doc.rows.length === 1 &&
                doc.rows[0].value.common.name !== hostname)
            {
                var oldHostname = doc.rows[0].value.common.name;
                var oldId  = doc.rows[0].value._id;

                // find out all instances and rewrite it to actual hostname
                objects.getObjectView('system', 'instance', {}, function (err, doc) {
                    if (err && err.status_code === 404) {
                        if (callback) callback();
                    } else if (doc.rows.length === 0) {
                        logger.info('host.' + hostname + ' no instances found');
                        // no instances found
                        if (callback) callback();
                    } else {
                        // reassign all instances
                        changeHost(doc.rows, oldHostname, hostname, function () {
                            logger.info('Delete host ' + oldId);

                            // delete host object
                            objects.delObject(oldId, function () {

                                // delete all hosts states
                                objects.getObjectView('system', 'state', {startkey: 'system.host.' + oldHostname + '.', endkey: 'system.host.' + oldHostname + '.\u9999', include_docs: true}, function (_err, doc) {
                                    delObjects(doc.rows, function () {
                                        if (callback) callback();
                                    });
                                });
                            });
                        });
                    }
                });
            } else if (callback) {
                callback();
            }
        });
    } else {
        if (callback) callback();
    }
}
// collect extended diag information
function collectDiagInfoExtended(callback) {
    return collectDiagInfo(callback);
}

// collect short diag information
function collectDiagInfo(callback) {
    objects.getObject('system.config', function (err, systemConfig) {
        objects.getObject('system.meta.uuid', function (err, obj) {
            // create uuid
            if (err || !obj) {
                obj = {native: {uuid: 'not found'}};
            }
            objects.getObjectView('system', 'host', {}, function (_err, doc) {
                var diag = {
                    uuid: obj.native.uuid,
                    language: systemConfig.common.language,
                    hosts: [],
                    adapters: {}
                };

                if (!_err && doc) {
                    if (doc && doc.rows.length) {
                        if (!semver) semver = require('semver');

                        doc.rows.sort(function (a, b) {
                            return semver.lt(a.value.common.installedVersion, b.value.common.installedVersion);
                        });
                        // Read installed versions of all hosts
                        for (var i = 0; i < doc.rows.length; i++) {

                            diag.hosts.push({
                                version:  doc.rows[i].value.common.installedVersion,
                                platform: doc.rows[i].value.common.platform,
                                type:     doc.rows[i].value.native.os.platform

                            });
                        }
                    }
                }
                objects.getObjectView('system', 'adapter', {}, function (__err, doc) {
                    if (!_err && doc) {
                        if (doc && doc.rows.length) {
                            // Read installed versions of all hosts
                            for (var i = 0; i < doc.rows.length; i++) {
                                diag.adapters[doc.rows[i].value.common.name] = {
                                    version: doc.rows[i].value.common.version,
                                    platform: doc.rows[i].value.common.platform
                                };
                            }
                        }
                    }
                    if (callback) callback(diag);
                });
            });
        });
    });
}

// check if some IPv4 address found. If not try in 30 seconds one more time (max 10 times)
function setIPs(ipList) {
    var _ipList = ipList || getIPs();

    // check if IPs detected (because of DHCP delay)
    var found = false;
    for (var a = 0; a < _ipList.length; a++) {
        if (_ipList[a] === '127.0.0.1' || _ipList[a] === '::1/128' || !_ipList[a].match(/^\d+\.\d+\.\d+\.\d+$/)) continue;
        found = true;
        break;
    }
    // IPv4 address still not found, try again in 30 seconds
    if (!found && detectIpsCount < 10) {
        detectIpsCount++;
        setTimeout(function () {
            setIPs();
        }, 30000);
    } else if (found) {
        // IPv4 found => write to object
        objects.getObject('system.host.' + hostname, function (err, oldObj) {
            var networkInterfaces = os.networkInterfaces();
            if (JSON.stringify(oldObj.native.hardware.networkInterfaces) !== JSON.stringify(networkInterfaces) ||
                JSON.stringify(oldObj.common.address)           !== JSON.stringify(ipList)) {
                oldObj.common.address = ipList;
                oldObj.native.hardware.networkInterfaces = networkInterfaces;

                objects.setObject(oldObj._id, oldObj, function (err) {
                    if (err) logger.error('Cannot write host object:' + err);
                });
            }
        });
    } else {
        logger.info('No IPv4 address found after 5 minutes.');
    }
}

function setMeta() {
    var id = 'system.host.' + hostname;

    objects.getObject(id, function (err, oldObj) {
        var newObj = {
            _id:  id,
            type: 'host',
            common: {
                name:             hostname,
                title:            ioPackage.common.title,
                installedVersion: version,
                platform:         ioPackage.common.platform,
                cmd:              process.argv[0] + ' ' + process.execArgv.join(' ') + ' ' + process.argv.slice(1).join(' '),
                hostname:         hostname,
                address:          getIPs(),
                type:             ioPackage.common.name
            },
            native: {
                process: {
                    title:      process.title,
                    versions:   process.versions,
                    env:        process.env
                },
                os: {
                    hostname:   hostname,
                    type:       os.type(),
                    platform:   os.platform(),
                    arch:       os.arch(),
                    release:    os.release(),
                    endianness: os.endianness(),
                    tmpdir:     os.tmpdir()
                },
                hardware: {
                    cpus:       os.cpus(),
                    totalmem:   os.totalmem()
                }
            }
        };

        // remove dynamic information
        if (newObj.native && newObj.native.hardware && newObj.native.hardware.cpus) {
            for (var c = 0; c < newObj.native.hardware.cpus.length; c++) {
                if (newObj.native.hardware.cpus[c].times) delete newObj.native.hardware.cpus[c].times;
            }
        }
        if (oldObj && oldObj.native.hardware && oldObj.native.hardware.networkInterfaces) {
            newObj.native.hardware.networkInterfaces = oldObj.native.hardware.networkInterfaces;
        }

        if (!oldObj || JSON.stringify(newObj) !== JSON.stringify(oldObj)) {
            objects.setObject(id, newObj, function (err) {
                if (err) logger.error('Cannot write host object:' + err);
            });
        }
        setIPs(newObj.common.address);
    });

    var _id = id + '.mem';
    var obj = {
        _id: _id,
        type: 'state',
        common: {
            type: 'number',
            name: 'Memory usage',
            unit: '%',
            read: true,
            write: false,
            min:  0,
            max:  100
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    _id = id + '.memHeapUsed';
    obj = {
        _id: _id,
        type: 'state',
        common: {
            type: 'number',
            name: 'Memory from heap used in MB',
            read: true,
            write: false,
            min: 0,
            unit: 'MB'
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    _id = id + '.memHeapTotal';
    obj = {
        _id: _id,
        type: 'state',
        common: {
            type: 'number',
            name: 'Memory heap reserved in MB',
            read: true,
            write: false,
            min: 0,
            unit: 'MB'
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    _id = id + '.memRss';
    obj = {
        _id: _id,
        type: 'state',
        common: {
            type: 'number',
            name: 'Resident set size in MB',
            desc: 'RSS is the resident set size, the portion of the process\'s memory held in RAM',
            read: true,
            write: false,
            min:  0,
            unit: 'MB'
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    _id = id + '.uptime';
    obj = {
        _id: _id,
        type: 'state',
        common: {
            type: 'number',
            name: 'Uptime in seconds',
            read: true,
            write: false,
            min: 0,
            unit: 'seconds'
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    _id = id + '.load';
    obj = {
        _id: _id,
        type: 'state',
        common: {
            unit: '',
            type: 'number',
            read: true,
            write: false,
            name: 'Load Average 1min'
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    _id = id + '.alive';
    obj = {
        _id: _id,
        type: 'state',
        common: {
            name: 'Host alive',
            read: true,
            write: false,
            type: 'boolean'
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    _id = id + '.freemem';
    obj = {
        _id: _id,
        type: 'state',
        common: {
            name: 'Available RAM in MB',
            unit: 'MB',
            read: true,
            write: false,
            type: 'number'
        },
        native: {}
    };
    objects.extendObject(_id, obj);

    // create UUID if not exist
    tools.createUuid(objects, function (uuid) {
        if (uuid && logger) logger.info('Created UUID: ' + uuid);
    });
}

// Subscribe on message queue
function initMessageQueue() {
    states.subscribeMessage('system.host.' + hostname);
}

// Send message to other adapter instance
function sendTo(objName, command, message, callback) {
    if (typeof message === 'undefined') {
        message = command;
        command = 'send';
    }
    var obj = {command: command, message: message, from: 'system.host.' + hostname};
    if (objName.substring(0, 'system.adapter.'.length) !== 'system.adapter.' &&
        objName.substring(0, 'system.host.'.length)    !== 'system.host.') objName = 'system.adapter.' + objName;

    if (callback) {
        if (typeof callback === 'function') {
            obj.callback = {
                message: message,
                id:      callbackId++,
                ack:     false,
                time:    (new Date()).getTime()
            };
            if (callbackId > 0xFFFFFFFF) callbackId = 1;
            if (!callbacks) callbacks = {};
            callbacks['_' + obj.callback.id] = {cb: callback};
        } else {
            obj.callback     = callback;
            obj.callback.ack = true;
        }
    }

    states.pushMessage(objName, obj);
}

function getVersionFromHost(hostId, callback) {
    states.getState(hostId + '.alive', function (err, state) {
        if (state && state.val)  {
            sendTo(hostId, 'getVersion', null, function (ioPack) {
                if (callback) setTimeout(callback, 0, ioPack);
            });
        } else {
            logger.warn('host.' + hostname + ' "' + hostId + '" is offline');
            if (callback) setTimeout(callback, 0, null, hostId);
        }
    });
}

// Process message to controller, like execute some script
function processMessage(msg) {
    var ioPack;
    switch (msg.command) {
        case 'cmdExec':
            var spawn = require('child_process').spawn;
            var args = [__dirname + '/' + tools.appName + '.js'];
            var cmd = msg.message.data.split(' ');
            for (var i = 0; i < cmd.length; i++) {
                args.push(cmd[i]);
            }
            logger.info(tools.appName + ' ' + args.slice(1).join(' '));

            var child = spawn('node', args);
            child.stdout.on('data', function (data) {
                data = data.toString().replace('\n', '');
                logger.info(tools.appName + ' ' + data);
                if (msg.from) sendTo(msg.from, 'cmdStdout', {id: msg.message.id, data: data});
            });

            child.stderr.on('data', function (data) {
                data = data.toString().replace('\n', '');
                logger.error(tools.appName + ' ' + data);
                if (msg.from) sendTo(msg.from, 'cmdStderr', {id: msg.message.id, data: data});
            });

            child.on('exit', function (exitCode) {
                logger.info(tools.appName + ' exit ' + exitCode);
                if (msg.from) {
                    sendTo(msg.from, 'cmdExit', {id: msg.message.id, data: exitCode});
                    // Sometimes finished command is lost, recent it
                    setTimeout(function () {
                        sendTo(msg.from, 'cmdExit', {id: msg.message.id, data: exitCode});
                    }, 1000);
                }
            });
            break;

        case 'getRepository':
            if (msg.callback && msg.from) {
                objects.getObject('system.config', function (err, systemConfig) {
                    // Collect statistics
                    if (systemConfig && systemConfig.common && systemConfig.common.diag) {
                        if (systemConfig.common.diag === 'normal') {
                            collectDiagInfo(function (obj) {
                                tools.sendDiagInfo(obj);
                            });
                        } else if (systemConfig.common.diag === 'extended') {
                            collectDiagInfoExtended(function (obj) {
                                tools.sendDiagInfo(obj);
                            });
                        }
                    }

                    objects.getObject('system.repositories', function (err, repos) {
                        // Check if repositories exists
                        if (!err && repos && repos.native && repos.native.repositories) {
                            var updateRepo = false;
                            if (typeof msg.message === 'object') {
                                updateRepo  = msg.message.update;
                                msg.message = msg.message.repo;
                            }

                            var active = msg.message || systemConfig.common.activeRepo;

                            if (repos.native.repositories[active]) {

                                if (typeof repos.native.repositories[active] === 'string') {
                                    repos.native.repositories[active] = {
                                        link: repos.native.repositories[active],
                                        json: null
                                    };
                                }

                                // If repo is not yet loaded
                                if (!repos.native.repositories[active].json || updateRepo) {
                                    logger.info('host.' + hostname + ' Update repository "' + active + '" under "' + repos.native.repositories[active].link + '"');
                                    // Load it
                                    tools.getRepositoryFile(repos.native.repositories[active].link, function (err, sources) {
                                        if (err) logger.warn('host.' + hostname + ' warning: ' + err);
                                        repos.native.repositories[active].json = sources;
                                        sendTo(msg.from, msg.command, repos.native.repositories[active].json, msg.callback);
                                        // Store uploaded repo
                                        objects.setObject('system.repositories', repos);
                                    });
                                } else {
                                    // We have already repo, give it back
                                    sendTo(msg.from, msg.command, repos.native.repositories[active].json, msg.callback);
                                }
                            } else {
                                logger.warn('host.' + hostname + ' Requested repository "' + active + '" does not exist in config.');
                                sendTo(msg.from, msg.command, null, msg.callback);
                            }
                        }
                    });
                });
            } else {
                logger.error('host.' + hostname + ' Invalid request ' + msg.command + '. "callback" or "from" is null');
            }
            break;

        case 'getInstalled':
            if (msg.callback && msg.from) {
                // Get list of all hosts
                objects.getObjectView('system', 'host', {}, function (err, doc) {
                    var result = tools.getInstalledInfo(version);
                    result.hosts = {};
                    var infoCount = 0;
                    var timeout = null;

                    if (doc && doc.rows.length) {
                        // Read installed versions of all hosts
                        for (var i = 0; i < doc.rows.length; i++) {
                            // If desired local version, do not ask it, just answer
                            if (doc.rows[i].id === 'system.host.' + hostname) {
                                var _ioPack;
                                try {
                                    _ioPack = JSON.parse(fs.readFileSync(__dirname + '/io-package.json'));
                                } catch (e) {
                                    logger.error('host.' + hostname + ' cannot read and parse "' + __dirname + '/io-package.json"');
                                }
                                if (_ioPack) {
                                    _ioPack.common.host = hostname;
                                    _ioPack.common.runningVersion = version;
                                    result.hosts[hostname] = _ioPack.common;
                                } else {
                                    result.hosts[hostname] = {};
                                }
                            } else {
                                infoCount++;
                                getVersionFromHost(doc.rows[i].id, function (ioPack, id) {
                                    if (ioPack) result.hosts[ioPack.host] = ioPack;

                                    if (!--infoCount) {
                                        if (timeout) {
                                            clearTimeout(timeout);
                                            timeout = null;
                                            sendTo(msg.from, msg.command, result, msg.callback);
                                        } else {
                                            logger.warn('host.' + hostname + ' too delayed answer for ' + (ioPack ? ioPack.host : id));
                                        }
                                    }
                                });
                            }
                        }
                    }
                    if (!infoCount) {
                        sendTo(msg.from, msg.command, result, msg.callback);
                    } else {
                        // Start timeout and send answer in 5 seconds if some hosts are offline
                        timeout = setTimeout(function () {
                            logger.warn('host.' + hostname + ' some hosts are offline');
                            timeout = null;
                            sendTo(msg.from, msg.command, result, msg.callback);
                        }, 5000);
                    }
                });
            } else {
                logger.error('host.' + hostname + ' Invalid request ' + msg.command + '. "callback" or "from" is null');
            }
            break;

        case 'getVersion':
            if (msg.callback && msg.from) {
                ioPack = null;
                try {
                    ioPack = JSON.parse(fs.readFileSync(__dirname + '/io-package.json'));
                } catch (e) {
                    logger.error('host.' + hostname + ' cannot read and parse "' + __dirname + '/io-package.json"');
                }
                if (ioPack) {
                    ioPack.common.host = hostname;
                    ioPack.common.runningVersion = version;
                    sendTo(msg.from, msg.command, ioPack.common, msg.callback);
                } else {
                    sendTo(msg.from, msg.command, null, msg.callback);
                }
            } else {
                logger.error('host.' + hostname + ' Invalid request ' + msg.command + '. "callback" or "from" is null');
            }
            break;

        case 'getDiagData':
            if (msg.callback && msg.from) {
                if (msg.message === 'normal') {
                    collectDiagInfo(function (obj) {
                        sendTo(msg.from, msg.command, obj, msg.callback);
                    });
                } else if (msg.message === 'extended') {
                    collectDiagInfoExtended(function (obj) {
                        sendTo(msg.from, msg.command, obj, msg.callback);
                    });
                } else {
                    sendTo(msg.from, msg.command, null, msg.callback);
                }
            } else {
                logger.error('host.' + hostname + ' Invalid request ' + msg.command + '. "callback" or "from" is null');
            }
            break;

        case 'getDevList':
            if (msg.callback && msg.from) {
                ioPack = null;

                if (require('os').platform() === 'linux') {
                    var _spawn = require('child_process').spawn;
                    var _args = ['/dev'];
                    logger.info('host.' + hostname + ' ls /dev');
                    var _child = _spawn('ls', _args);
                    var result = '';
                    _child.stdout.on('data', function (data) {
                        result += data.toString();
                    });
                    _child.stderr.on('data', function (data) {
                        logger.error('host.' + hostname + ' ls ' + data);
                    });

                    _child.on('exit', function (/*exitCode*/) {
                        result = result.replace(/(\r\n|\n|\r|\t)/gm, ' ');
                        var parts = result.split(' ');
                        var resList = [];
                        for (var t = 0; t < parts.length; t++) {
                            parts[t] = parts[t].trim();
                            if (parts[t]) resList.push(parts[t]);
                        }

                        sendTo(msg.from, msg.command, resList, msg.callback);
                    });
                    break;

                } else {
                    sendTo(msg.from, msg.command, null, msg.callback);
                }
            } else {
                logger.error('host.' + hostname + ' Invalid request ' + msg.command + '. "callback" or "from" is null');
            }
            break;

        case 'getLogs':
            if (msg.callback && msg.from) {
                ioPack = null;

                var lines = msg.message || 200;
                var text  = '';
                var logFile_ = logger.getFileName(); //__dirname + '/log/' + tools.appName + '.log';
                if (!fs.existsSync(logFile_)) logFile_ = __dirname + '/../../log/' + tools.appName + '.log';

                if (fs.existsSync(logFile_)) {
                    var stats = fs.statSync(logFile_);

                    fs.createReadStream(logFile_, {
                        start: (stats.size > 150 * lines) ? stats.size - 150 * lines : 0,
                        end:   stats.size
                    }).on('data', function (chunk) {
                        text += chunk.toString();
                    })
                        .on('end', function () {  // done
                            var lines = text.split('\n');
                            lines.shift();
                            lines.push(stats.size);
                            sendTo(msg.from, msg.command, lines, msg.callback);
                        }).on('error', function () {  // done
                        sendTo(msg.from, msg.command, [stats.size], msg.callback);
                    });
                } else {
                    sendTo(msg.from, msg.command, [0], msg.callback);
                }
            } else {
                logger.error('host.' + hostname + ' Invalid request ' + msg.command + '. "callback" or "from" is null');
            }
            break;

        case 'delLogs':
            var logFile = logger.getFileName(); //__dirname + '/log/' + tools.appName + '.log';
            if (fs.existsSync(__dirname +       '/log/' + tools.appName + '.log')) fs.writeFile(__dirname +       '/log/' + tools.appName + '.log', '');
            if (fs.existsSync(__dirname + '/../../log/' + tools.appName + '.log')) fs.writeFile(__dirname + '/../../log/' + tools.appName + '.log', '');
            if (fs.existsSync(logFile)) fs.writeFile(logFile);

            if (msg.callback && msg.from) sendTo(msg.from, msg.command, null, msg.callback);
            break;

        case 'readDirAsZip':
            if (msg.callback && msg.from) {
                zipFiles = zipFiles || require(__dirname + '/lib/zipFiles');
                zipFiles.readDirAsZip(objects, msg.message.id, msg.message.name, msg.message.options, function (err, base64) {
                    if (base64) {
                        sendTo(msg.from, msg.command, {error: err, data: base64}, msg.callback);
                    } else {
                        sendTo(msg.from, msg.command, {error: err}, msg.callback);
                    }
                });
            }
            break;

        case 'writeDirAsZip':
            zipFiles = zipFiles || require(__dirname + '/lib/zipFiles');
            zipFiles.writeDirAsZip(objects, msg.message.id, msg.message.name, new Buffer(msg.message.data, 'base64'), msg.message.options, function (err) {
                if (msg.callback && msg.from) sendTo(msg.from, msg.command, {error: err}, msg.callback);
            });
            break;

        case 'readObjectsAsZip':
            if (msg.callback && msg.from) {
                zipFiles = zipFiles || require(__dirname + '/lib/zipFiles');
                zipFiles.readObjectsAsZip(objects, msg.message.id, msg.message.adapter, msg.message.options, function (err, base64) {
                    if (base64) {
                        sendTo(msg.from, msg.command, {error: err, data: base64}, msg.callback);
                    } else {
                        sendTo(msg.from, msg.command, {error: err}, msg.callback);
                    }
                });
            }
            break;

        case 'writeObjectsAsZip':
            zipFiles = zipFiles || require(__dirname + '/lib/zipFiles');
            zipFiles.writeObjectsAsZip(objects, msg.message.id, msg.message.adapter, new Buffer(msg.message.data, 'base64'), msg.message.options, function (err) {
                if (msg.callback && msg.from) sendTo(msg.from, msg.command, {error: err}, msg.callback);
            });
            break;
    }
}

function getInstances() {
    objects.getObjectView('system', 'instance', {}, function (err, doc) {
        if (err && err.status_code === 404) {
            logger.error('host.' + hostname + ' _design/system missing - call node ' + tools.appName + '.js setup');
            //if (objects.destroy) objects.destroy();
            //if (states  && states.destroy)  states.destroy();
            //process.exit(1);
            return;
        } else if (doc.rows.length === 0) {
            logger.info('host.' + hostname + ' no instances found');
        } else {
            var _ipArr = getIPs();
            logger.info('host.' + hostname + ' ' + doc.rows.length + ' instance' + (doc.rows.length === 1 ? '' : 's') + ' found');
            var count = 0;

            // first mark all instances as disabled to detect disabled once
            for (var id in procs) {
                if (procs.hasOwnProperty(id) && procs[id].config && procs[id].config.common && procs[id].config.common.enabled) {
                    procs[id].config.common.enabled = false;
                }
            }

            for (var i = 0; i < doc.rows.length; i++) {
                var instance = doc.rows[i].value;

                // register all common fields, that may not be deleted, like "mobile" or "history"
                //noinspection JSUnresolvedVariable
                if (objects.addPreserveSettings && instance.common.preserveSettings) {
                    //noinspection JSUnresolvedVariable
                    objects.addPreserveSettings(instance.common.preserveSettings);
                }

                if (instance.common.mode === 'web' || instance.common.mode === 'none') continue;

                logger.debug('host.' + hostname + ' check instance "' + doc.rows[i].id  + '" for host "' + instance.common.host + '"');
                console.log('host.' + hostname + ' check instance "' + doc.rows[i].id  + '" for host "' + instance.common.host + '"');

                if (_ipArr.indexOf(instance.common.host) !== -1 || instance.common.host === hostname) {
                    procs[instance._id] = procs[instance._id] || {};
                    procs[instance._id].config = JSON.parse(JSON.stringify(instance));
                    if (instance.common.enabled) count++;
                }
            }

            if (count > 0) {
                logger.info('host.' + hostname + ' starting ' + count + ' instance' + (count > 1 ? 's' : ''));
            } else {
                logger.warn('host.' + hostname + ' does not start any instances on this host');
            }
        }

        initInstances();
    });
}

function initInstances() {
    var seconds = 0;
    var interval = 2000;
    var id;

    // Start first admin
    for (id in procs) {
        if (!procs.hasOwnProperty(id)) continue;

        if (procs[id].config.common.enabled) {
            if (id.indexOf('system.adapter.admin') !== -1) {
                // do not process if still running. It will be started when old one will be finished
                if (procs[id].process) {
                    logger.info('host.' + hostname + ' instance "' + id + '" was not started, becasue running.');
                    continue;
                }
                if (installQueue.indexOf(id) === -1) {
                    setTimeout(function (_id) {
                        startInstance(_id);
                    }, interval * seconds, id);

                    seconds += 2; // 4 seconds pause between starts
                }
            }
        } else if (procs[id].process) {
            // stop instance if disabled
            stopInstance(id);
        }
    }

    for (id in procs) {
        if (!procs.hasOwnProperty(id)) continue;

        if (procs[id].config.common.enabled && id.indexOf('system.adapter.admin') === -1) {
            // do not process if still running. It will be started when old one will be finished
            if (procs[id].process) {
                logger.info('host.' + hostname + ' instance "' + id + '" was not started, becasue running.');
                continue;
            }

            if (installQueue.indexOf(id) === -1) {
                setTimeout(function (_id) {
                    startInstance(_id);
                }, interval * seconds, id);

                seconds += 2; // 4 seconds pause between starts
            }
        }
    }
}

function checkVersion(id, name, version) {
    var isFound = false;

    if (name === 'js-controller') {
        // Check only version
        if (version !== null) {
            if (!semver) semver = require('semver');
            if (!semver.satisfies(ioPackage.common.version, version)) {
                logger.error('host.' + hostname + ' startInstance ' + id + 'Invalid version of "' + name + '". Installed "' + ioPackage.common.version + '", required "' + version);
                return false;
            } else {
                isFound = true;
            }
        } else {
            isFound = true;
        }
    }
    if (!isFound) {
        for (var p in procs) {
            if (!procs.hasOwnProperty(p)) continue;
            if (procs[p] && procs[p].config && procs[p].config.common && procs[p].config.common.name === name) {
                if (version && !semver.satisfies(procs[p].config.common.version, version)) {
                    logger.error('host.' + hostname + ' startInstance ' + id + ': required adapter "' + name + '" has wrong version. Installed "' + procs[p].common.version + '", required "' + version + '"!');
                    return false;
                }
                isFound = true;
            }
        }
    }

    if (!isFound) {
        logger.error('host.' + hostname + ' startInstance ' + id + ': required adapter "' + name + '" not found!');
        return false;
    } else {
        return true;
    }
}

function checkVersions(id, deps) {
    try {
        if (deps instanceof Array) {
            for (var d = 0; d < deps.length; deps++) {
                var version = null;
                var name    = null;
                if (typeof deps[d] === 'object') {
                    if (!semver) semver = require('semver');

                    for (var n in deps[d]) {
                        if (!deps[d].hasOwnProperty(n)) continue;
                        name    = n;
                        version = deps[d][n];
                        break;
                    }
                } else {
                    name = deps[d];
                }
                if (!checkVersion(id, name, version)) return false;
            }
        } else if (typeof deps === 'object') {
            if (deps.length !== undefined || deps[0]) {
                for (var i in deps) {
                    if (!deps.hasOwnProperty(i)) continue;
                    for (var __name in deps[i]) {
                        if (!deps[i].hasOwnProperty(__name)) continue;
                        if (!checkVersion(id, __name, deps[__name][i])) {
                            return false;
                        }
                    }                }
            } else {
                for (var _name in deps) {
                    if (!deps.hasOwnProperty(_name)) continue;
                    if (!checkVersion(id, _name, deps[_name])) {
                        return false;
                    }
                }
            }
        }
    }
    catch (e) {
        logger.error('host.' + hostname + ' startInstance ' + id + ': ' + e);
        return false;
    }
    return true;
}

// Store process IDS to make possible kill them all by restart
function storePids() {
    if (!storeTimer) {
        storeTimer = setTimeout(function () {
            storeTimer = null;
            var pids = [];
            for (var id in procs) {
                if (!procs.hasOwnProperty(id)) continue;

                if (procs[id].process) {
                    pids.push(procs[id].process.pid);
                }
                pids.push(process.pid);
            }
            fs.writeFileSync(__dirname + '/pids.txt', JSON.stringify(pids));
        }, 500);
    }
}

function installAdapters() {
    if (!installQueue.length) return;

    var task = installQueue[0];
    var name = task.id.split('.')[2];

    if (procs[task.id].downloadRetry < 3) {
        procs[task.id].downloadRetry++;
        logger.warn('host.' + hostname + ' startInstance cannot find start file for adapter "' + name + '". Try to install it... ' + procs[task.id].downloadRetry + ' attempt');
        logger.info(tools.appName + ' install ' + name);

        var child = require('child_process').spawn('node', [__dirname + '/' + tools.appName + '.js', 'install', name]);
        child.stdout.on('data', function (data) {
            data = data.toString().replace('\n', '');
            logger.info(tools.appName + ' ' + data);
        });
        child.stderr.on('data', function (data) {
            data = data.toString().replace('\n', '');
            logger.error(tools.appName + ' ' + data);
        });
        child.on('exit', function (exitCode) {
            logger.info(tools.appName + ' exit ' + exitCode);
            startInstance(task.id, task.wakeUp);

            setTimeout(function () {
                installQueue.shift();
                installAdapters();
            });
        });
    } else {
        logger.error('host.' + hostname + ' Cannot download adapter "' + name + '". To restart it disable/enable it or restart host.');
        setTimeout(function () {
            installQueue.shift();
            installAdapters();
        }, 500);
    }
}

function startInstance(id, wakeUp) {
    if (isStopping || !connected) return;

    if (!procs[id]) {
        logger.error('host.' + hostname + ' startInstance ' + id + ': object not found!');
        return;
    }

    var instance = procs[id].config;
    var name = id.split('.')[2];
    var mode = instance.common.mode;

    if (wakeUp) mode = 'daemon';

    //noinspection JSUnresolvedVariable
    if (instance.common.wakeup) {
        // TODO
    }

    // Check if all required adapters installed and have valid version
    if (instance.common.dependencies) {
        if (checkVersions(id, instance.common.dependencies)) {
            delete instance.common.dependencies;
        } else {
            return;
        }
    }

    var fileName = instance.common.main || 'main.js';
    var adapterDir = tools.getAdapterDir(name);
    if (!fs.existsSync(adapterDir)) {
        procs[id].downloadRetry = procs[id].downloadRetry || 0;
        installQueue.push({id: id, wakeUp: wakeUp});
        // start install queue if not started
        if (installQueue.length === 1) installAdapters();
        return;
    }

    var args = (instance && instance._id && instance.common) ? [instance._id.split('.').pop(), instance.common.loglevel || 'info'] : [0, 'info'];

    // define memory limit for adapter
    //noinspection JSUnresolvedVariable
    if (instance.common.memoryLimitMB && parseInt(instance.common.memoryLimitMB, 10)) {
        //noinspection JSUnresolvedVariable
        args.push('--max-old-space-size=' + parseInt(instance.common.memoryLimitMB, 10));
    }

    var fileNameFull = adapterDir + '/' + fileName;

    // workaround for old vis.
    if (instance.common.onlyWWW && name === 'vis') instance.common.onlyWWW = false;

    if (instance.common.onlyWWW || !fs.existsSync(fileNameFull)) {
        fileName = name + '.js';
        fileNameFull = adapterDir + '/' + fileName;
        if (instance.common.onlyWWW || !fs.existsSync(fileNameFull)) {
            // If not just www files
            if (instance.common.onlyWWW || fs.existsSync(adapterDir + '/www')) {
                logger.debug('host.' + hostname + ' startInstance ' + name + '.' + args[0] + ' only WWW files. Nothing to start');
            } else {
                logger.error('host.' + hostname + ' startInstance ' + name + '.' + args[0] + ': cannot find start file!');
            }
            return;
        }
    }
    procs[id].downloadRetry = 0;


    //noinspection JSUnresolvedVariable
    if (instance.common.subscribe || instance.common.wakeup) {
        procs[id].subscribe = instance.common.subscribe || instance._id + '.wakeup';
        var parts = instance._id.split('.');
        var instanceId = parts[parts.length - 1];
        procs[id].subscribe = procs[id].subscribe.replace('<INSTANCE>', instanceId);

        if (subscribe[procs[id].subscribe]) {
            if (subscribe[procs[id].subscribe].indexOf(id) === -1) {
                subscribe[procs[id].subscribe].push(id);
            }
        } else {
            subscribe[procs[id].subscribe] = [id];

            // Subscribe on changes
            if (procs[id].subscribe.match(/$messagebox/)) {
                states.subscribeMessage(procs[id].subscribe.substring('messagebox'.length));
            } else {
                states.subscribe(procs[id].subscribe);
            }
        }
    }

    switch (mode) {
        case 'once':
        case 'daemon':
            if (procs[id] && !procs[id].process) {
                allInstancesStopped = false;
                logger.debug('host.' + hostname + ' startInstance ' + name + '.' + args[0] + ' loglevel=' + args[1]);
                procs[id].process = cp.fork(fileNameFull, args);
                storePids(); // Store all pids to make possible kill them all
                procs[id].process.on('exit', function (code, signal) {
                    states.setState(id + '.alive',     {val: false, ack: true, from: 'system.host.' + hostname});
                    states.setState(id + '.connected', {val: false, ack: true, from: 'system.host.' + hostname});

                    if (procs[id] && procs[id].config && procs[id].config.common.logTransporter) states.setState(id + '.logging', {val: false, ack: true, from: 'system.host.' + hostname});

                    if (mode !== 'once') {
                        if (signal) {
                            logger.warn('host.' + hostname + ' instance ' + id + ' terminated due to ' + signal);
                        } else if (code === null) {
                            logger.error('host.' + hostname + ' instance ' + id + ' terminated abnormally');
                        }

                        if ((procs[id] && procs[id].stopping) || isStopping || wakeUp) {
                            logger.info('host.' + hostname + ' instance ' + id + ' terminated with code ' + code + ' (' + (errorCodes[code] || '') + ')');
                            delete procs[id].stopping;

                            if (procs[id].process) delete procs[id].process;

                            if (isStopping) {
                                for (var i in procs) {
                                    if (!procs.hasOwnProperty(i)) continue;
                                    if (procs[i].process) {
                                        //console.log(procs[i].config.common.name + ' still running');
                                        return;
                                    }
                                }
                                logger.info('host.' + hostname + ' All instances are stopped.');
                                allInstancesStopped = true;
                            }
                            storePids(); // Store all pids to make possible kill them all
                            return;
                        } else {
                            //noinspection JSUnresolvedVariable
                            if (code === 4294967196 /* -100 */ && procs[id].config.common.restartSchedule) {
                                logger.info('host.' + hostname + ' instance ' + id + ' scheduled normal terminated and will be started anew.');
                            } else {
                                logger.error('host.' + hostname + ' instance ' + id + ' terminated with code ' + code + ' (' + (errorCodes[code] || '') + ')');
                            }
                        }
                    }

                    if (procs[id] && procs[id].process) delete procs[id].process;
                    if (!wakeUp && connected && !isStopping && procs[id] && procs[id].config && procs[id].config.common && procs[id].config.common.enabled && mode !== 'once') {

                        logger.info('host.' + hostname + ' Restart adapter ' + id + ' because enabled');

                        //noinspection JSUnresolvedVariable
                        setTimeout(function (_id) {
                            startInstance(_id);
                        }, procs[id].config.common.restartSchedule ? 1000 : 30000, id);
                    } else {
                        if (mode !== 'once') {
                            logger.info('host.' + hostname + ' Do not restart adapter ' + id + ' because disabled or deleted');
                        } else {
                            logger.info('host.' + hostname + ' instance ' + id + ' terminated while should be started once');
                        }
                    }
                    storePids(); // Store all pids to make possible kill them all
                });
                if (!wakeUp && procs[id] && procs[id].config.common && procs[id].config.common.enabled && mode !== 'once') logger.info('host.' + hostname + ' instance ' + instance._id + ' started with pid ' + procs[id].process.pid);
            } else {
                if (!wakeUp && procs[id]) logger.warn('host.' + hostname + ' instance ' + instance._id + ' already running with pid ' + procs[id].process.pid);
            }
            break;

        case 'schedule':
            if (!instance.common.schedule) {
                logger.error(instance._id + ' schedule attribute missing');
                break;
            }
            if (procs[id].schedule) {
                procs[id].schedule.cancel();
                logger.info('host.' + hostname + ' instance canceled schedule ' + instance._id);
            }

            procs[id].schedule = schedule.scheduleJob(instance.common.schedule, function () {
                if (!procs[id]) {
                    logger.error('host.' + hostname + ' scheduleJob: Task deleted (' + id + ')');
                    return;
                }
                // After sleep of PC all scheduled runs come together. There is no need to run it X times in one second. Just the last.
                if (procs[id].lastStart && (new Date()).getTime() - procs[id].lastStart < 2000) {
                    logger.warn('host.' + hostname + ' instance ' + instance._id + ' does not started, because just executed');
                    return;
                }
                // Remember the last run
                procs[id].lastStart = new Date().getTime();
                if (!procs[id].process) {
                    var args = [instance._id.split('.').pop(), instance.common.loglevel || 'info'];
                    procs[id].process = cp.fork(fileNameFull, args);
                    storePids(); // Store all pids to make possible kill them all
                    logger.info('host.' + hostname + ' instance ' + instance._id + ' started with pid ' + procs[instance._id].process.pid);

                    procs[id].process.on('exit', function (code, signal) {
                        states.setState(id + '.alive', {val: false, ack: true, from: 'system.host.' + hostname});
                        if (signal) {
                            logger.warn('host.' + hostname + ' instance ' + id + ' terminated due to ' + signal);
                        } else if (code === null) {
                            logger.error('host.' + hostname + ' instance ' + id + ' terminated abnormally');
                        } else {
                            if (code === 0 || code === '0') {
                                logger.info('host.' + hostname + ' instance ' + id + ' terminated with code ' + code + ' (' + (errorCodes[code] || '') + ')');
                            } else {
                                logger.error('host.' + hostname + ' instance ' + id + ' terminated with code ' + code + ' (' + (errorCodes[code] || '') + ')');
                            }
                        }
                        if (procs[id] && procs[id].process) delete procs[id].process;
                        storePids(); // Store all pids to make possible kill them all
                    });
                } else {
                    if (!wakeUp) logger.warn('host.' + hostname + ' instance ' + instance._id + ' already running with pid ' + procs[id].process.pid);
                }
            });
            logger.info('host.' + hostname + ' instance scheduled ' + instance._id + ' ' + instance.common.schedule);
            // Start one time adapter by start or if configuration changed
            //noinspection JSUnresolvedVariable
            if (instance.common.allowInit) {
                procs[id].process = cp.fork(fileNameFull, args);
                storePids(); // Store all pids to make possible kill them all
                logger.info('host.' + hostname + ' instance ' + instance._id + ' started with pid ' + procs[instance._id].process.pid);

                procs[id].process.on('exit', function (code, signal) {
                    states.setState(id + '.alive', {val: false, ack: true, from: 'system.host.' + hostname});
                    if (signal) {
                        logger.warn('host.' + hostname + ' instance ' + id + ' terminated due to ' + signal);
                    } else if (code === null) {
                        logger.error('host.' + hostname + ' instance ' + id + ' terminated abnormally');
                    } else {
                        if (code === 0 || code === '0') {
                            logger.info('host.' + hostname + ' instance ' + id + ' terminated with code ' + code + ' (' + (errorCodes[code] || '') + ')');
                        } else {
                            logger.error('host.' + hostname + ' instance ' + id + ' terminated with code ' + code + ' (' + (errorCodes[code] || '') + ')');
                        }
                    }
                    delete procs[id].process;
                    storePids(); // Store all pids to make possible kill them all
                });
            }

            break;

        case 'subscribe':
            break;

        default:
            logger.error(instance._id + ' invalid mode');

    }
}

function stopInstance(id, callback) {
    logger.info('host.' + hostname + ' stopInstance ' + id);
    if (!procs[id]) {
        logger.warn('host.' + hostname + ' unknown instance ' + id);
        if (typeof callback === 'function') callback();
        return;
    }

    var instance = procs[id].config;
    if (!instance || !instance.common || !instance.common.mode) {
        if (procs[id].process) {
            procs[id].stopping = true;
            procs[id].process.kill();
            delete(procs[id].process);
        }
        if (procs[id].schedule) {
            procs[id].schedule.cancel();
            delete(procs[id].schedule);
        }

        if (procs[id].subscribe) {
            // Remove this id from subsribed on this message
            if (subscribe[procs[id].subscribe] && subscribe[procs[id].subscribe].indexOf(id) !== -1) {
                subscribe[procs[id].subscribe].splice(subscribe[procs[id].subscribe].indexOf(id), 1);

                // If no one subscribed
                if (!subscribe[procs[id].subscribe].length) {
                    // Delete item
                    delete subscribe[procs[id].subscribe];

                    // Unsubscribe
                    if (procs[id].subscribe.match(/$messagebox/)) {
                        states.unsubscribeMessage(procs[id].subscribe.substring('messagebox'.length));
                    } else {
                        states.unsubscribe(procs[id].subscribe);
                    }
                }
            }
        }
        if (typeof callback === 'function') callback();
        return;
    }

    switch (instance.common.mode) {
        case 'daemon':
            if (!procs[id].process) {
                logger.warn('host.' + hostname + ' stopInstance ' + instance._id + ' not running');
                if (typeof callback === 'function') callback();
            } else {
                //noinspection JSUnresolvedVariable
                if (instance.common.messagebox && instance.common.supportStopInstance) {
                    var timeout;
                    // Send to adapter signal "stopInstance" because on some systems SIGTERM does not work
                    sendTo(instance._id, 'stopInstance', null, function () {
                        if (timeout) {
                            clearTimeout(timeout);
                            timeout = null;
                        }
                        logger.info('host.' + hostname + ' stopInstance ' + instance._id + ' killing pid ' + procs[id].process.pid);
                        procs[id].stopping = true;
                        procs[id].process.kill();
                        delete(procs[id].process);
                        if (typeof callback === 'function') callback();
                    });
                    // If no response from adapter, kill it in 1 second
                    timeout = setTimeout(function () {
                        if (procs[id].process) {
                            logger.info('host.' + hostname + ' stopInstance ' + instance._id + ' killing pid  ' + procs[id].process.pid);
                            procs[id].stopping = true;
                            procs[id].process.kill();
                            delete(procs[id].process);
                            if (typeof callback === 'function') callback();
                        }
                    }, 1000);
                } else {
                    logger.info('host.' + hostname + ' stopInstance ' + instance._id + ' killing pid ' + procs[id].process.pid);
                    procs[id].stopping = true;
                    procs[id].process.kill();
                    delete(procs[id].process);
                    if (typeof callback === 'function') callback();
                }
            }
            break;

        case 'schedule':
            if (!procs[id].schedule) {
                logger.warn('host.' + hostname + ' stopInstance ' + instance._id + ' not scheduled');
            } else {
                procs[id].schedule.cancel();
                delete procs[id].schedule;
                logger.info('host.' + hostname + ' stopInstance canceled schedule ' + instance._id);
            }
            if (typeof callback === 'function') callback();
            break;

        case 'subscribe':
            // Remove this id from subscribed on this message
            if (subscribe[procs[id].subscribe] && subscribe[procs[id].subscribe].indexOf(id) !== -1) {
                subscribe[procs[id].subscribe].splice(subscribe[procs[id].subscribe].indexOf(id), 1);

                // If no one subscribed
                if (!subscribe[procs[id].subscribe].length) {
                    // Delete item
                    delete subscribe[procs[id].subscribe];

                    // Unsubscribe
                    if (procs[id].subscribe.match(/$messagebox/)) {
                        states.unsubscribeMessage(procs[id].subscribe.substring('messagebox'.length));
                    } else {
                        states.unsubscribe(procs[id].subscribe);
                    }
                }
            }

            if (!procs[id].process) {
                if (typeof callback === 'function') callback();
            } else {
                logger.info('host.' + hostname + ' stopInstance ' + instance._id + ' killing pid ' + procs[id].process.pid);
                procs[id].stopping = true;
                procs[id].process.kill();
                delete(procs[id].process);
                if (typeof callback === 'function') callback();
            }
            break;

        default:
    }
}
/*
 //test disconnect
 setTimeout(function () {
 if (disconnectTimeout) clearTimeout(disconnectTimeout);
 disconnectTimeout = setTimeout(function () {
 console.log('TEST !!!!! STOP!!!! ===============================================');
 connected = false;
 disconnectTimeout = null;
 logger.warn('host.' + hostname + ' Slave controller detected disconnection. Stop all instances.');
 stopInstances(true, function () {
 // if during stopping the DB has connection again
 if (connected && !isStopping) {
 getInstances();
 startAliveInterval();
 initMessageQueue();
 }
 });
 }, config.objects.connectTimeout || 2000);

 }, 60000);

 setTimeout(function () {
 console.log('TEST !!!!! START AGAIN!!!! ===============================================');
 // stop disconnect timeout
 if (disconnectTimeout) {
 clearTimeout(disconnectTimeout);
 disconnectTimeout = null;
 }

 if (!connected) {
 if (connected === null) setMeta();

 connected = true;
 logger.info('host.' + hostname + ' ' + ' connected');

 // Do not start if we still stopping the instances
 if (!isStopping) {
 getInstances();
 startAliveInterval();
 initMessageQueue();
 }
 }
 }, 63000);
 */

function stopInstances(forceStop, callback) {
    var timeout;
    function waitForInstances() {
        if (!allInstancesStopped) {
            setTimeout(waitForInstances, 200);
        } else {
            if (timeout) clearTimeout(timeout);
            isStopping = null;
            if (typeof callback === 'function') callback();
            callback = null;
        }
    }

    try {
        var elapsed = (isStopping ? ((new Date()).getTime() - isStopping) : 0);
        logger.debug('host.' + hostname + ' stop isStopping=' + elapsed + ' isDaemon=' + isDaemon + ' allInstancesStopped=' + allInstancesStopped);
        if (elapsed >= stopTimeout) {
            isStopping = null;
            if (timeout) clearTimeout(timeout);
            if (typeof callback === 'function') callback(true);
            callback = null;
        } else {
            // Sometimes process receives SIGTERM twice
            isStopping = isStopping || new Date().getTime();
        }

        if (forceStop || isDaemon) {
            // send instances SIGTERM, only needed if running in background (isDaemon)
            // or slave lost connection to master
            for (var id in procs) {
                if (!procs.hasOwnProperty(id)) continue;
                stopInstance(id);
            }
        }

        waitForInstances();
    } catch (e) {
        logger.error(e.message);
        isStopping = null;
        if (timeout) clearTimeout(timeout);
        if (typeof callback === 'function') callback();
        callback   = null;
    }

    // force after Xs
    timeout = setTimeout(function () {
        timeout    = null;
        isStopping = null;
        if (typeof callback === 'function') callback(true);
        callback   = null;
    }, stopTimeout);
}

function stop() {
    stopInstances(false, function (wasForced) {
        if (objects && objects.destroy) objects.destroy();

        states.setState('system.host.' + hostname + '.alive', {val: false, ack: true, from: 'system.host.' + hostname}, function () {
            logger.info('host.' + hostname + ' ' + (wasForced ? 'force terminating' : 'terminated'));
            if (wasForced) {
                for (var i in procs) {
                    if (!procs.hasOwnProperty(i)) continue;
                    if (procs[i].process) {
                        if (procs[i].config && procs[i].config.common && procs[i].config.common.name) {
                            logger.info('Adapter ' + procs[i].config.common.name + ' still running');
                        }
                    }
                }
            }
            if (states  && states.destroy)  states.destroy();
            setTimeout(function () {
                process.exit(1);
            }, 1000);
        });
    });
}

process.on('SIGINT', function () {
    logger.info('host.' + hostname + ' received SIGINT');
    stop();
});

process.on('SIGTERM', function () {
    logger.info('host.' + hostname + ' received SIGTERM');
    stop();
});

process.on('uncaughtException', function (err) {
    if (err.arguments && err.arguments[0] === 'fragmentedOperation') {
        logger.error('fragmentedOperation: restart objects');
        // restart objects
        objects.destroy();
        objects = null;
        // Give time to close the objects
        setTimeout(function () {
            objects = createObjects();
        }, 3000);
        return;
    }

    // If by terminating one more exception => stop immediately to break the circle
    if (uncaughtExceptionCount) {
        console.error(err.message || err);
        if (err.stack) console.error(err.stack);
        process.exit(2);
        return;
    }
    uncaughtExceptionCount++;
    if (typeof err === 'object') {
        if (err.errno === 'EADDRINUSE') {
            logger.error('Another instance is running or some application uses port!');
            logger.error('uncaught exception: ' + err.message);
        } else {
            logger.error('uncaught exception: ' + err.message);
            logger.error(err.stack);
        }
    } else {
        logger.error('uncaught exception: ' + err);
    }
    stop();
    // Restart itself
    processMessage({command: 'cmdExec', message: {data: '_restart'}});
});
