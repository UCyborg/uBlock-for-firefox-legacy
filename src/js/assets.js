/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-2018 Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

'use strict';

/******************************************************************************/

µBlock.assets = (function() {

/******************************************************************************/

var reIsExternalPath = /^(?:[a-z-]+):\/\//,
    reIsUserAsset = /^user-/,
    errorCantConnectTo = vAPI.i18n('errorCantConnectTo'),
    noopfunc = function(){};

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const EXPIRES_DEFAULT = 7;

var api = {
};

/******************************************************************************/

var observers = [];

api.addObserver = function(observer) {
    if ( observers.indexOf(observer) === -1 ) {
        observers.push(observer);
    }
};

api.removeObserver = function(observer) {
    var pos;
    while ( (pos = observers.indexOf(observer)) !== -1 ) {
        observers.splice(pos, 1);
    }
};

var fireNotification = function(topic, details) {
    var result, r;
    for ( var i = 0; i < observers.length; i++ ) {
        r = observers[i](topic, details);
        if ( r !== undefined ) { result = r; }
    }
    return result;
};

/******************************************************************************/

api.fetchText = function(url, onLoad, onError) {
    var isExternal = reIsExternalPath.test(url),
        actualUrl = isExternal ? url : vAPI.getURL(url);

    // https://github.com/gorhill/uBlock/issues/2592
    // Force browser cache to be bypassed, but only for resources which have
    // been fetched more than one hour ago.
    if ( isExternal ) {
        var queryValue = '_=' + Math.floor(Date.now() / 7200000);
        if ( actualUrl.indexOf('?') === -1 ) {
            actualUrl += '?';
        } else {
            actualUrl += '&';
        }
        actualUrl += queryValue;
    }

    if ( typeof onError !== 'function' ) {
        onError = onLoad;
    }

    var contentLoaded = 0,
        timeoutAfter = µBlock.hiddenSettings.assetFetchTimeout * 1000 || 30000,
        timeoutTimer,
        xhr = new XMLHttpRequest();

    var cleanup = function() {
        xhr.removeEventListener('load', onLoadEvent);
        xhr.removeEventListener('error', onErrorEvent);
        xhr.removeEventListener('abort', onErrorEvent);
        xhr.removeEventListener('progress', onProgressEvent);
        if ( timeoutTimer !== undefined ) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
        }
    };

    // https://github.com/gorhill/uMatrix/issues/15
    var onLoadEvent = function() {
        cleanup();
        // xhr for local files gives status 0, but actually succeeds
        var details = {
            url: url,
            content: '',
            statusCode: this.status || 200,
            statusText: this.statusText || ''
        };
        if ( details.statusCode < 200 || details.statusCode >= 300 ) {
            return onError.call(null, details);
        }
        // consider an empty result to be an error
        if ( stringIsNotEmpty(this.responseText) === false ) {
            return onError.call(null, details);
        }
        // we never download anything else than plain text: discard if response
        // appears to be a HTML document: could happen when server serves
        // some kind of error page I suppose
        var text = this.responseText.trim();
        if ( text.startsWith('<') && text.endsWith('>') ) {
            return onError.call(null, details);
        }
        details.content = this.responseText;
        onLoad(details);
    };

    var onErrorEvent = function() {
        cleanup();
        µBlock.logger.writeOne('', 'error', errorCantConnectTo.replace('{{msg}}', actualUrl));
        onError({ url: url, content: '' });
    };

    var onTimeout = function() {
        xhr.abort();
    };

    // https://github.com/gorhill/uBlock/issues/2526
    // - Timeout only when there is no progress.
    var onProgressEvent = function(ev) {
        if ( ev.loaded === contentLoaded ) { return; }
        contentLoaded = ev.loaded;
        if ( timeoutTimer !== undefined ) {
            clearTimeout(timeoutTimer);
        }
        timeoutTimer = vAPI.setTimeout(onTimeout, timeoutAfter);
    };

    // Be ready for thrown exceptions:
    // I am pretty sure it used to work, but now using a URL such as
    // `file:///` on Chromium 40 results in an exception being thrown.
    try {
        xhr.open('get', actualUrl, true);
        xhr.addEventListener('load', onLoadEvent);
        xhr.addEventListener('error', onErrorEvent);
        xhr.addEventListener('abort', onErrorEvent);
        xhr.addEventListener('progress', onProgressEvent);
        xhr.responseType = 'text';
        xhr.send();
        timeoutTimer = vAPI.setTimeout(onTimeout, timeoutAfter);
    } catch (e) {
        onErrorEvent.call(xhr);
    }
};

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/3331
//   Support the seamless loading of sublists.

api.fetchFilterList = function(mainlistURL, onLoad, onError) {
    const content = [];
    const pendingSublistURLs = new Set([ mainlistURL ]);
    const loadedSublistURLs = new Set();
    const toParsedURL = api.fetchFilterList.toParsedURL;

    let errored = false;

    // https://github.com/NanoAdblocker/NanoCore/issues/239
    //   Anything under URL's root directory is allowed to be fetched. The
    //   URL of a sublist will always be relative to the URL of the parent
    //   list (instead of the URL of the root list).
    var rootDirectoryURL = toParsedURL(
        reIsExternalPath.test(mainlistURL)
            ? mainlistURL
            : vAPI.getURL(mainlistURL)
    );
    if ( rootDirectoryURL !== undefined ) {
        var pos = rootDirectoryURL.pathname.lastIndexOf('/');
        if ( pos !== -1 ) {
            rootDirectoryURL.pathname =
                rootDirectoryURL.pathname.slice(0, pos + 1);
        }
    }

    const processIncludeDirectives = function(details) {
        const reInclude = /^!#include +(\S+)/gm;
        const out = [];
        const content = details.content;
        let lastIndex = 0;
        for (;;) {
            const match = reInclude.exec(content);
            if ( match === null ) { break; }
            if ( toParsedURL(match[1]) !== undefined ) { continue; }
            if ( match[1].indexOf('..') !== -1 ) { continue; }
            const pos = details.url.lastIndexOf('/');
            if ( pos === -1 ) { continue; }
            const subURL = details.url.slice(0, pos + 1) + match[1];
            if ( pendingSublistURLs.has(subURL) ) { continue; }
            if ( loadedSublistURLs.has(subURL) ) { continue; }
            pendingSublistURLs.add(subURL);
            api.fetchText(subURL, onLocalLoadSuccess, onLocalLoadError);
            out.push(content.slice(lastIndex, match.index).trim(), subURL);
            lastIndex = reInclude.lastIndex;
        }
        out.push(lastIndex === 0 ? content : content.slice(lastIndex).trim());
        return out;
    };

    const onLocalLoadSuccess = function(details) {
        if ( errored ) { return; }

        const isSublist = details.url !== mainlistURL;

        pendingSublistURLs.delete(details.url);
        loadedSublistURLs.add(details.url);
        // https://github.com/uBlockOrigin/uBlock-issues/issues/329
        //   Insert fetched content at position of related #!include directive
        let slot = isSublist ? content.indexOf(details.url) : 0;
        if ( isSublist ) {
            content.splice(
                slot,
                1,
                '! >>>>>>>> ' + details.url,
                details.content.trim(),
                '! <<<<<<<< ' + details.url
            );
            slot += 1;
        } else {
            content[0] = details.content.trim();
        }

        // Find and process #!include directives
        if (
            rootDirectoryURL !== undefined &&
            rootDirectoryURL.pathname.length > 0
        ) {
            const processed = processIncludeDirectives(details);
            if ( processed.length > 1 ) {
                content.splice(slot, 1, ...processed);
            }
        }

        if ( pendingSublistURLs.size !== 0 ) { return; }

        details.url = mainlistURL;
        details.content = content.join('\n').trim();
        onLoad(details);
    };

    // https://github.com/AdguardTeam/FiltersRegistry/issues/82
    //   Not checking for `errored` status was causing repeated notifications
    //   to the caller. This can happens when more than one out of multiple
    //   sublists can't be fetched.
    const onLocalLoadError = function(details) {
        if ( errored ) { return; }

        errored = true;
        details.url = mainlistURL;
        details.content = '';
        onError(details);
    };

    this.fetchText(mainlistURL, onLocalLoadSuccess, onLocalLoadError);
};

api.fetchFilterList.toParsedURL = function(url) {
    try {
        return new URL(url);
    } catch (ex) {
    }
};

/*******************************************************************************

    The purpose of the asset source registry is to keep key detail information
    about an asset:
    - Where to load it from: this may consist of one or more URLs, either local
      or remote.
    - After how many days an asset should be deemed obsolete -- i.e. in need of
      an update.
    - The origin and type of an asset.
    - The last time an asset was registered.

**/

var assetSourceRegistryStatus,
    assetSourceRegistry = Object.create(null);

var registerAssetSource = function(assetKey, dict) {
    var entry = assetSourceRegistry[assetKey] || {};
    for ( var prop in dict ) {
        if ( dict.hasOwnProperty(prop) === false ) { continue; }
        if ( dict[prop] === undefined ) {
            delete entry[prop];
        } else {
            entry[prop] = dict[prop];
        }
    }
    var contentURL = dict.contentURL;
    if ( contentURL !== undefined ) {
        if ( typeof contentURL === 'string' ) {
            contentURL = entry.contentURL = [ contentURL ];
        } else if ( Array.isArray(contentURL) === false ) {
            contentURL = entry.contentURL = [];
        }
        var remoteURLCount = 0;
        for ( var i = 0; i < contentURL.length; i++ ) {
            if ( reIsExternalPath.test(contentURL[i]) ) {
                remoteURLCount += 1;
            }
        }
        entry.hasLocalURL = remoteURLCount !== contentURL.length;
        entry.hasRemoteURL = remoteURLCount !== 0;
    } else if ( entry.contentURL === undefined ) {
        entry.contentURL = [];
    }
    if ( typeof entry.updateAfter !== 'number' ) {
        entry.updateAfter = EXPIRES_DEFAULT;
    }
    if ( entry.submitter ) {
        entry.submitTime = Date.now(); // To detect stale entries
    }
    assetSourceRegistry[assetKey] = entry;
};

var unregisterAssetSource = function(assetKey) {
    assetCacheRemove(assetKey);
    delete assetSourceRegistry[assetKey];
};

var saveAssetSourceRegistry = (function() {
    var timer;
    var save = function() {
        timer = undefined;
        vAPI.cacheStorage.set({ assetSourceRegistry: assetSourceRegistry });
    };
    return function(lazily) {
        if ( timer !== undefined ) {
            clearTimeout(timer);
        }
        if ( lazily ) {
            timer = vAPI.setTimeout(save, 500);
        } else {
            save();
        }
    };
})();

var updateAssetSourceRegistry = function(json, silent) {
    var newDict;
    try {
        newDict = JSON.parse(json);
    } catch (ex) {
    }
    if ( newDict instanceof Object === false ) { return; }

    var oldDict = assetSourceRegistry,
        assetKey;

    // Remove obsolete entries (only those which were built-in).
    for ( assetKey in oldDict ) {
        if (
            newDict[assetKey] === undefined &&
            oldDict[assetKey].submitter === undefined
        ) {
            unregisterAssetSource(assetKey);
        }
    }
    // Add/update existing entries. Notify of new asset sources.
    for ( assetKey in newDict ) {
        if ( oldDict[assetKey] === undefined && !silent ) {
            fireNotification(
                'builtin-asset-source-added',
                { assetKey: assetKey, entry: newDict[assetKey] }
            );
        }
        registerAssetSource(assetKey, newDict[assetKey]);
    }
    saveAssetSourceRegistry();
};

var getAssetSourceRegistry = function(callback) {
    // Already loaded.
    if ( assetSourceRegistryStatus === 'ready' ) {
        callback(assetSourceRegistry);
        return;
    }

    // Being loaded.
    if ( Array.isArray(assetSourceRegistryStatus) ) {
        assetSourceRegistryStatus.push(callback);
        return;
    }

    // Not loaded: load it.
    assetSourceRegistryStatus = [ callback ];

    var registryReady = function() {
        var callers = assetSourceRegistryStatus;
        assetSourceRegistryStatus = 'ready';
        var fn;
        while ( (fn = callers.shift()) ) {
            fn(assetSourceRegistry);
        }
    };

    // First-install case.
    var createRegistry = function() {
        api.fetchText(
            µBlock.assetsBootstrapLocation || 'assets/assets.json',
            function(details) {
                updateAssetSourceRegistry(details.content, true);
                registryReady();
            }
        );
    };

    vAPI.cacheStorage.get('assetSourceRegistry', function(bin) {
        if ( !bin || !bin.assetSourceRegistry ) {
            createRegistry();
            return;
        }
        assetSourceRegistry = bin.assetSourceRegistry;
        registryReady();
    });
};

api.registerAssetSource = function(assetKey, details) {
    getAssetSourceRegistry(function() {
        registerAssetSource(assetKey, details);
        saveAssetSourceRegistry(true);
    });
};

api.unregisterAssetSource = function(assetKey) {
    getAssetSourceRegistry(function() {
        unregisterAssetSource(assetKey);
        saveAssetSourceRegistry(true);
    });
};

/*******************************************************************************

    The purpose of the asset cache registry is to keep track of all assets
    which have been persisted into the local cache.

**/

var assetCacheRegistryStatus,
    assetCacheRegistryStartTime = Date.now(),
    assetCacheRegistry = {};

var getAssetCacheRegistry = function(callback) {
    // Already loaded.
    if ( assetCacheRegistryStatus === 'ready' ) {
        callback(assetCacheRegistry);
        return;
    }

    // Being loaded.
    if ( Array.isArray(assetCacheRegistryStatus) ) {
        assetCacheRegistryStatus.push(callback);
        return;
    }

    // Not loaded: load it.
    assetCacheRegistryStatus = [ callback ];

    var registryReady = function() {
        var callers = assetCacheRegistryStatus;
        assetCacheRegistryStatus = 'ready';
        var fn;
        while ( (fn = callers.shift()) ) {
            fn(assetCacheRegistry);
        }
    };

    vAPI.cacheStorage.get('assetCacheRegistry', function(bin) {
        if ( bin && bin.assetCacheRegistry ) {
            assetCacheRegistry = bin.assetCacheRegistry;
        }
        registryReady();
    });
};

var saveAssetCacheRegistry = (function() {
    var timer;
    var save = function() {
        timer = undefined;
        vAPI.cacheStorage.set({ assetCacheRegistry: assetCacheRegistry });
    };
    return function(lazily) {
        if ( timer !== undefined ) { clearTimeout(timer); }
        if ( lazily ) {
            timer = vAPI.setTimeout(save, 500);
        } else {
            save();
        }
    };
})();

var assetCacheRead = function(assetKey, callback) {
    var internalKey = 'cache/' + assetKey;

    var reportBack = function(content, err) {
        var details = { assetKey: assetKey, content: content };
        if ( err ) { details.error = err; }
        callback(details);
    };

    var onAssetRead = function(bin) {
        if ( !bin || !bin[internalKey] ) {
            return reportBack('', 'E_NOTFOUND');
        }
        var entry = assetCacheRegistry[assetKey];
        if ( entry === undefined ) {
            return reportBack('', 'E_NOTFOUND');
        }
        entry.readTime = Date.now();
        saveAssetCacheRegistry(true);
        reportBack(bin[internalKey]);
    };

    var onReady = function() {
        vAPI.cacheStorage.get(internalKey, onAssetRead);
    };

    getAssetCacheRegistry(onReady);
};

var assetCacheWrite = function(assetKey, details, callback) {
    var internalKey = 'cache/' + assetKey;
    var content = '';
    if ( typeof details === 'string' ) {
        content = details;
    } else if ( details instanceof Object ) {
        content = details.content || '';
    }

    if ( content === '' ) {
        return assetCacheRemove(assetKey, callback);
    }

    var reportBack = function(content) {
        var details = { assetKey: assetKey, content: content };
        if ( typeof callback === 'function' ) {
            callback(details);
        }
        fireNotification('after-asset-updated', details);
    };

    var onReady = function() {
        var entry = assetCacheRegistry[assetKey];
        if ( entry === undefined ) {
            entry = assetCacheRegistry[assetKey] = {};
        }
        entry.writeTime = entry.readTime = Date.now();
        if ( details instanceof Object && typeof details.url === 'string' ) {
            entry.remoteURL = details.url;
        }
        var bin = { assetCacheRegistry: assetCacheRegistry };
        bin[internalKey] = content;
        vAPI.cacheStorage.set(bin);
        reportBack(content);
    };
    getAssetCacheRegistry(onReady);
};

var assetCacheRemove = function(pattern, callback) {
    var onReady = function() {
        var cacheDict = assetCacheRegistry,
            removedEntries = [],
            removedContent = [];
        for ( var assetKey in cacheDict ) {
            if ( pattern instanceof RegExp && !pattern.test(assetKey) ) {
                continue;
            }
            if ( typeof pattern === 'string' && assetKey !== pattern ) {
                continue;
            }
            removedEntries.push(assetKey);
            removedContent.push('cache/' + assetKey);
            delete cacheDict[assetKey];
        }
        if ( removedContent.length !== 0 ) {
            vAPI.cacheStorage.remove(removedContent);
            var bin = { assetCacheRegistry: assetCacheRegistry };
            vAPI.cacheStorage.set(bin);
        }
        if ( typeof callback === 'function' ) {
            callback();
        }
        for ( var i = 0; i < removedEntries.length; i++ ) {
            fireNotification('after-asset-updated', { assetKey: removedEntries[i] });
        }
    };

    getAssetCacheRegistry(onReady);
};

var assetCacheMarkAsDirty = function(pattern, exclude, callback) {
    var onReady = function() {
        var cacheDict = assetCacheRegistry,
            cacheEntry,
            mustSave = false;
        for ( var assetKey in cacheDict ) {
            if ( pattern instanceof RegExp ) {
                if ( pattern.test(assetKey) === false ) { continue; }
            } else if ( typeof pattern === 'string' ) {
                if ( assetKey !== pattern ) { continue; }
            } else if ( Array.isArray(pattern) ) {
                if ( pattern.indexOf(assetKey) === -1 ) { continue; }
            }
            if ( exclude instanceof RegExp ) {
                if ( exclude.test(assetKey) ) { continue; }
            } else if ( typeof exclude === 'string' ) {
                if ( assetKey === exclude ) { continue; }
            } else if ( Array.isArray(exclude) ) {
                if ( exclude.indexOf(assetKey) !== -1 ) { continue; }
            }
            cacheEntry = cacheDict[assetKey];
            if ( !cacheEntry.writeTime ) { continue; }
            cacheDict[assetKey].writeTime = 0;
            mustSave = true;
        }
        if ( mustSave ) {
            var bin = { assetCacheRegistry: assetCacheRegistry };
            vAPI.cacheStorage.set(bin);
        }
        if ( typeof callback === 'function' ) {
            callback();
        }
    };
    if ( typeof exclude === 'function' ) {
        callback = exclude;
        exclude = undefined;
    }
    getAssetCacheRegistry(onReady);
};

/******************************************************************************/

var stringIsNotEmpty = function(s) {
    return typeof s === 'string' && s !== '';
};

/*******************************************************************************

    User assets are NOT persisted in the cache storage. User assets are
    recognized by the asset key which always starts with 'user-'.

    TODO(seamless migration):
    Can remove instances of old user asset keys when I am confident all users
    are using uBO v1.11 and beyond.

**/

var readUserAsset = function(assetKey, callback) {
    var reportBack = function(content) {
        callback({ assetKey: assetKey, content: content });
    };

    var onLoaded = function(bin) {
        if ( !bin ) { return reportBack(''); }
        var content = '';
        if ( typeof bin['cached_asset_content://assets/user/filters.txt'] === 'string' ) {
            content = bin['cached_asset_content://assets/user/filters.txt'];
            vAPI.cacheStorage.remove('cached_asset_content://assets/user/filters.txt');
        }
        if ( typeof bin['assets/user/filters.txt'] === 'string' ) {
            content = bin['assets/user/filters.txt'];
            // TODO(seamless migration):
            // Uncomment once all moved to v1.11+.
            //vAPI.storage.remove('assets/user/filters.txt');
        }
        if ( typeof bin[assetKey] === 'string' ) {
            // TODO(seamless migration):
            // Replace conditional with assignment once all moved to v1.11+
            if ( content !== bin[assetKey] ) {
                saveUserAsset(assetKey, content);
            }
        } else if ( content !== '' ) {
            saveUserAsset(assetKey, content);
        }
        return reportBack(content);
    };
    var toRead = assetKey;
    if ( assetKey === µBlock.userFiltersPath ) {
        toRead = [
            assetKey,
            'assets/user/filters.txt',
            'cached_asset_content://assets/user/filters.txt'
        ];
    }
    vAPI.storage.get(toRead, onLoaded);
};

var saveUserAsset = function(assetKey, content, callback) {
    var bin = {};
    bin[assetKey] = content;
    // TODO(seamless migration):
    // This is for forward compatibility. Only for a limited time. Remove when
    // everybody moved to 1.11.0 and beyond.
    // >>>>>>>>
    if ( assetKey === µBlock.userFiltersPath ) {
        bin['assets/user/filters.txt'] = content;
    }
    // <<<<<<<<
    var onSaved = function() {
        if ( callback instanceof Function ) {
            callback({ assetKey: assetKey, content: content });
        }
    };
    vAPI.storage.set(bin, onSaved);
};

/******************************************************************************/

api.get = function(assetKey, options, callback) {
    if ( typeof options === 'function' ) {
        callback = options;
        options = {};
    } else if ( typeof callback !== 'function' ) {
        callback = noopfunc;
    }

    if ( assetKey === µBlock.userFiltersPath ) {
        readUserAsset(assetKey, callback);
        return;
    }

    var assetDetails = {},
        contentURLs,
        contentURL;

    let reportBack = (content, err) => {
        const details = { assetKey, content };
        if ( err ) {
            details.error = assetDetails.lastError = err;
        } else {
            assetDetails.lastError = undefined;
        }
        if ( options.needSourceURL ) {
            if (
                contentURL === undefined &&
                assetCacheRegistry instanceof Object &&
                assetCacheRegistry[assetKey] instanceof Object
            ) {
                details.sourceURL = assetCacheRegistry[assetKey].remoteURL;
            }
            if ( reIsExternalPath.test(contentURL) ) {
                details.sourceURL = contentURL;
            }
        }
        callback(details);
    };

    let onContentNotLoaded = ( ) => {
        var isExternal;
        while ( (contentURL = contentURLs.shift()) ) {
            isExternal = reIsExternalPath.test(contentURL);
            if ( isExternal === false || assetDetails.hasLocalURL !== true ) {
                break;
            }
        }
        if ( !contentURL ) {
            return reportBack('', 'E_NOTFOUND');
        }
        if ( assetDetails.content === 'filters' ) {
            api.fetchFilterList(contentURL, onContentLoaded, onContentNotLoaded);
        } else {
            api.fetchText(contentURL, onContentLoaded, onContentNotLoaded);
        }
    };

    let onContentLoaded = details => {
        if ( stringIsNotEmpty(details.content) === false ) {
            onContentNotLoaded();
            return;
        }
        if ( reIsExternalPath.test(contentURL) && options.dontCache !== true ) {
            assetCacheWrite(assetKey, {
                content: details.content,
                url: contentURL
            });
        }
        reportBack(details.content);
    };

    let onCachedContentLoaded = details => {
        if ( details.content !== '' ) {
            return reportBack(details.content);
        }
        getAssetSourceRegistry(function(registry) {
            assetDetails = registry[assetKey] || {};
            if ( typeof assetDetails.contentURL === 'string' ) {
                contentURLs = [ assetDetails.contentURL ];
            } else if ( Array.isArray(assetDetails.contentURL) ) {
                contentURLs = assetDetails.contentURL.slice(0);
            } else {
                contentURLs = [];
            }
            onContentNotLoaded();
        });
    };

    assetCacheRead(assetKey, onCachedContentLoaded);
};

/******************************************************************************/

var getRemote = function(assetKey, callback) {
   var assetDetails = {},
        contentURLs,
        contentURL;

    var reportBack = function(content, err) {
        var details = { assetKey: assetKey, content: content };
        if ( err ) {
            details.error = assetDetails.lastError = err;
        } else {
            assetDetails.lastError = undefined;
        }
        callback(details);
    };

    var onRemoteContentLoaded = function(details) {
        if ( stringIsNotEmpty(details.content) === false ) {
            registerAssetSource(assetKey, { error: { time: Date.now(), error: 'No content' } });
            tryLoading();
            return;
        }
        assetCacheWrite(assetKey, {
            content: details.content,
            url: contentURL
        });
        registerAssetSource(assetKey, { error: undefined });
        reportBack(details.content);
    };

    var onRemoteContentError = function(details) {
        var text = details.statusText;
        if ( details.statusCode === 0 ) {
            text = 'network error';
        }
        registerAssetSource(assetKey, { error: { time: Date.now(), error: text } });
        tryLoading();
    };

    var tryLoading = function() {
        if ( contentURLs.length < 2 ) {
            contentURL = contentURLs.shift();
        } else {
            while ( (contentURL = contentURLs.shift()) ) {
                if ( reIsExternalPath.test(contentURL) ) { break; }
            }
        }
        if ( !contentURL ) {
            return reportBack('', 'E_NOTFOUND');
        }
        if ( assetDetails.content === 'filters' ) {
            api.fetchFilterList(contentURL, onRemoteContentLoaded, onRemoteContentError);
        } else {
            api.fetchText(contentURL, onRemoteContentLoaded, onRemoteContentError);
        }
    };

    getAssetSourceRegistry(function(registry) {
        assetDetails = registry[assetKey] || {};
        if ( typeof assetDetails.contentURL === 'string' ) {
            contentURLs = [ assetDetails.contentURL ];
        } else if ( Array.isArray(assetDetails.contentURL) ) {
            contentURLs = assetDetails.contentURL.slice(0);
        } else {
            contentURLs = [];
        }
        tryLoading();
    });
};

/******************************************************************************/

api.put = function(assetKey, content, callback) {
    if ( reIsUserAsset.test(assetKey) ) {
        return saveUserAsset(assetKey, content, callback);
    }
    assetCacheWrite(assetKey, content, callback);
};

/******************************************************************************/

api.metadata = function(callback) {
    let assetRegistryReady = false,
        cacheRegistryReady = false;

    let onReady = function() {
        let assetDict = JSON.parse(JSON.stringify(assetSourceRegistry));
        const cacheDict = assetCacheRegistry;
        const now = Date.now();
        for ( let assetKey in assetDict ) {
            const assetEntry = assetDict[assetKey];
            const cacheEntry = cacheDict[assetKey];
            if ( cacheEntry ) {
                assetEntry.cached = true;
                assetEntry.writeTime = cacheEntry.writeTime;
                const obsoleteAfter =
                    cacheEntry.writeTime + assetEntry.updateAfter * MS_PER_DAY;
                assetEntry.obsolete = obsoleteAfter < now;
                assetEntry.remoteURL = cacheEntry.remoteURL;
            } else if (
                assetEntry.contentURL &&
                assetEntry.contentURL.length !== 0
            ) {
                assetEntry.writeTime = 0;
                assetEntry.obsolete = true;
            }
        }
        callback(assetDict);
    };

    getAssetSourceRegistry(( ) => {
        assetRegistryReady = true;
        if ( cacheRegistryReady ) { onReady(); }
    });

    getAssetCacheRegistry(function() {
        cacheRegistryReady = true;
        if ( assetRegistryReady ) { onReady(); }
    });
};

/******************************************************************************/

api.purge = assetCacheMarkAsDirty;

api.remove = function(pattern, callback) {
    assetCacheRemove(pattern, callback);
};

api.rmrf = function() {
    assetCacheRemove(/./);
};

/******************************************************************************/

// Asset updater area.
var updaterStatus,
    updaterTimer,
    updaterAssetDelayDefault = 120000,
    updaterAssetDelay = updaterAssetDelayDefault,
    updaterUpdated = [],
    updaterFetched = new Set();

var updateFirst = function() {
    updaterStatus = 'updating';
    updaterFetched.clear();
    updaterUpdated = [];
    fireNotification('before-assets-updated');
    updateNext();
};

var updateNext = function() {
    var assetDict, cacheDict;

    // This will remove a cached asset when it's no longer in use.
    var garbageCollectOne = function(assetKey) {
        var cacheEntry = cacheDict[assetKey];
        if ( cacheEntry && cacheEntry.readTime < assetCacheRegistryStartTime ) {
            assetCacheRemove(assetKey);
        }
    };

    var findOne = function() {
        var now = Date.now(),
            assetEntry, cacheEntry;
        for ( var assetKey in assetDict ) {
            assetEntry = assetDict[assetKey];
            if ( updaterFetched.has(assetKey) ) { continue; }
            cacheEntry = cacheDict[assetKey];
            if ( cacheEntry && (cacheEntry.writeTime + assetEntry.updateAfter * MS_PER_DAY) > now ) {
                continue;
            }
            if (
                fireNotification(
                    'before-asset-updated',
                    { assetKey: assetKey,  type: assetEntry.content }
                ) === true
            ) {
                return assetKey;
            }
            garbageCollectOne(assetKey);
        }
    };

    var updatedOne = function(details) {
        if ( details.content !== '' ) {
            updaterUpdated.push(details.assetKey);
            if ( details.assetKey === 'assets.json' ) {
                updateAssetSourceRegistry(details.content);
            }
        } else {
            fireNotification('asset-update-failed', { assetKey: details.assetKey });
        }
        if ( findOne() !== undefined ) {
            vAPI.setTimeout(updateNext, updaterAssetDelay);
        } else {
            updateDone();
        }
    };

    var updateOne = function() {
        var assetKey = findOne();
        if ( assetKey === undefined ) {
            return updateDone();
        }
        updaterFetched.add(assetKey);
        getRemote(assetKey, updatedOne);
    };

    getAssetSourceRegistry(function(dict) {
        assetDict = dict;
        if ( !cacheDict ) { return; }
        updateOne();
    });

    getAssetCacheRegistry(function(dict) {
        cacheDict = dict;
        if ( !assetDict ) { return; }
        updateOne();
    });
};

var updateDone = function() {
    var assetKeys = updaterUpdated.slice(0);
    updaterFetched.clear();
    updaterUpdated = [];
    updaterStatus = undefined;
    updaterAssetDelay = updaterAssetDelayDefault;
    fireNotification('after-assets-updated', { assetKeys: assetKeys });
};

api.updateStart = function(details) {
    var oldUpdateDelay = updaterAssetDelay,
        newUpdateDelay = typeof details.delay === 'number' ?
            details.delay :
            updaterAssetDelayDefault;
    updaterAssetDelay = Math.min(oldUpdateDelay, newUpdateDelay);
    if ( updaterStatus !== undefined ) {
        if ( newUpdateDelay < oldUpdateDelay ) {
            clearTimeout(updaterTimer);
            updaterTimer = vAPI.setTimeout(updateNext, updaterAssetDelay);
        }
        return;
    }
    updateFirst();
};

api.updateStop = function() {
    if ( updaterTimer ) {
        clearTimeout(updaterTimer);
        updaterTimer = undefined;
    }
    if ( updaterStatus !== undefined ) {
        updateDone();
    }
};

/******************************************************************************/

return api;

/******************************************************************************/

})();

/******************************************************************************/
