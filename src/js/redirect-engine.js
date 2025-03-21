/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2015-2018 Raymond Hill

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

µBlock.redirectEngine = (function(){

/******************************************************************************/
/******************************************************************************/

let warResolve = (function() {
    var warPairs = [];

    var onPairsReady = function() {
        var reng = µBlock.redirectEngine;
        for ( var i = 0; i < warPairs.length; i += 2 ) {
            var resource = reng.resources.get(warPairs[i+0]);
            if ( resource === undefined ) { continue; }
            resource.warURL = vAPI.getURL(
                '/web_accessible_resources/' + warPairs[i+1]
            );
        }
        reng.selfieFromResources();
    };

    return function() {
        if ( vAPI.warSecret === undefined || warPairs.length !== 0 ) {
            return onPairsReady();
        }

        var onPairsLoaded = function(details) {
            var marker = '>>>>>';
            var pos = details.content.indexOf(marker);
            if ( pos === -1 ) { return; }
            var pairs = details.content.slice(pos + marker.length)
                                      .trim()
                                      .split('\n');
            if ( (pairs.length & 1) !== 0 ) { return; }
            for ( var i = 0; i < pairs.length; i++ ) {
                pairs[i] = pairs[i].trim();
            }
            warPairs = pairs;
            onPairsReady();
        };

        µBlock.assets.fetchText(
            '/web_accessible_resources/imported.txt?secret=' + vAPI.warSecret,
            onPairsLoaded
        );
    };
})();

/******************************************************************************/
/******************************************************************************/

let RedirectEntry = function() {
    this.mime = '';
    this.data = '';
    this.warURL = undefined;
};

/******************************************************************************/

// Prevent redirection to web accessible resources when the request is
// of type 'xmlhttprequest', because XMLHttpRequest.responseURL would
// cause leakage of extension id. See:
// - https://stackoverflow.com/a/8056313
// - https://bugzilla.mozilla.org/show_bug.cgi?id=998076

RedirectEntry.prototype.toURL = function(details) {
    if (
        this.warURL !== undefined &&
        details instanceof Object &&
        details.requestType !== 'xmlhttprequest'
    ) {
        return this.warURL + '?secret=' + vAPI.warSecret;
    }
    if ( this.data.startsWith('data:') === false ) {
        if ( this.mime.indexOf(';') === -1 ) {
            this.data = 'data:' + this.mime + ';base64,' + btoa(this.data);
        } else {
            this.data = 'data:' + this.mime + ',' + this.data;
        }
    }
    return this.data;
};

/******************************************************************************/

RedirectEntry.prototype.toContent = function() {
    if ( this.data.startsWith('data:') ) {
        var pos = this.data.indexOf(',');
        var base64 = this.data.endsWith(';base64', pos);
        this.data = this.data.slice(pos + 1);
        if ( base64 ) {
            this.data = atob(this.data);
        }
    }
    return this.data;
};

/******************************************************************************/

RedirectEntry.fromFields = function(mime, lines) {
    var r = new RedirectEntry();
    r.mime = mime;
    r.data = lines.join(mime.indexOf(';') !== -1 ? '' : '\n');
    return r;
};

/******************************************************************************/

RedirectEntry.fromSelfie = function(selfie) {
    var r = new RedirectEntry();
    r.mime = selfie.mime;
    r.data = selfie.data;
    r.warURL = selfie.warURL;
    return r;
};

/******************************************************************************/
/******************************************************************************/

let RedirectEngine = function() {
    this.aliases = new Map();
    this.resources = new Map();
    this.reset();
    this.resourceNameRegister = '';
};

/******************************************************************************/

RedirectEngine.prototype.reset = function() {
    this.rules = new Map();
    this.ruleTypes = new Set();
    this.ruleSources = new Set();
    this.ruleDestinations = new Set();
    this._desAll = []; // re-use better than re-allocate
    this.modifyTime = Date.now();
};

/******************************************************************************/

RedirectEngine.prototype.freeze = function() {
};

/******************************************************************************/

RedirectEngine.prototype.toBroaderHostname = function(hostname) {
    var pos = hostname.indexOf('.');
    if ( pos !== -1 ) {
        return hostname.slice(pos + 1);
    }
    return hostname !== '*' ? '*' : '';
};

/******************************************************************************/

RedirectEngine.prototype.lookup = function(context) {
    const type = context.requestType;
    if ( this.ruleTypes.has(type) === false ) { return; }
    const desAll = this._desAll,
          reqURL = context.requestURL;
    let src = context.pageHostname,
        des = context.requestHostname,
        n = 0;
    for (;;) {
        if ( this.ruleDestinations.has(des) ) {
            desAll[n] = des; n += 1;
        }
        des = this.toBroaderHostname(des);
        if ( des === '' ) { break; }
    }
    if ( n === 0 ) { return; }
    for (;;) {
        if ( this.ruleSources.has(src) ) {
            for ( let i = 0; i < n; i++ ) {
                const entries = this.rules.get(`${src} ${desAll[i]} ${type}`);
                if ( entries && this.lookupToken(entries, reqURL) ) {
                    return this.resourceNameRegister;
                }
            }
        }
        src = this.toBroaderHostname(src);
        if ( src === '' ) { break; }
    }
};

RedirectEngine.prototype.lookupToken = function(entries, reqURL) {
    let j = entries.length;
    while ( j-- ) {
        let entry = entries[j];
        if ( entry.pat instanceof RegExp === false ) {
            entry.pat = new RegExp(entry.pat, 'i');
        }
        if ( entry.pat.test(reqURL) ) {
            this.resourceNameRegister = entry.tok;
            return true;
        }
    }
};

/******************************************************************************/

RedirectEngine.prototype.toURL = function(context) {
    const token = this.lookup(context);
    if ( token === undefined ) { return; }
    const entry = this.resources.get(this.aliases.get(token) || token);
    if ( entry !== undefined ) {
        return entry.toURL(context);
    }
};

/******************************************************************************/

RedirectEngine.prototype.matches = function(context) {
    const token = this.lookup(context);
    return token !== undefined && this.resources.has(this.aliases.get(token) || token);
};

/******************************************************************************/

RedirectEngine.prototype.addRule = function(src, des, type, pattern, redirect) {
    this.ruleSources.add(src);
    this.ruleDestinations.add(des);
    this.ruleTypes.add(type);
    var key = src + ' ' + des + ' ' + type,
        entries = this.rules.get(key);
    if ( entries === undefined ) {
        this.rules.set(key, [ { tok: redirect, pat: pattern } ]);
        this.modifyTime = Date.now();
        return;
    }
    var entry;
    for ( var i = 0, n = entries.length; i < n; i++ ) {
        entry = entries[i];
        if ( redirect === entry.tok ) { break; }
    }
    if ( i === n ) {
        entries.push({ tok: redirect, pat: pattern });
        return;
    }
    var p = entry.pat;
    if ( p instanceof RegExp ) {
        p = p.source;
    }
    // Duplicate?
    var pos = p.indexOf(pattern);
    if ( pos !== -1 ) {
        if ( pos === 0 || p.charAt(pos - 1) === '|' ) {
            pos += pattern.length;
            if ( pos === p.length || p.charAt(pos) === '|' ) { return; }
        }
    }
    entry.pat = p + '|' + pattern;
};

/******************************************************************************/

RedirectEngine.prototype.fromCompiledRule = function(line) {
    const fields = line.split('\t');
    if ( fields.length !== 5 ) { return; }
    this.addRule(fields[0], fields[1], fields[2], fields[3], fields[4]);
};

/******************************************************************************/

RedirectEngine.prototype.compileRuleFromStaticFilter = function(line) {
    const matches = this.reFilterParser.exec(line);
    if ( matches === null || matches.length !== 4 ) { return; }

    const des = matches[1] || '';

    // https://github.com/uBlockOrigin/uBlock-issues/issues/572
    //   Extract best possible hostname.
    let deshn = des;
    let pos = deshn.lastIndexOf('*');
    if ( pos !== -1 ) {
        deshn = deshn.slice(pos + 1);
        pos = deshn.indexOf('.');
        if ( pos !== -1 ) {
            deshn = deshn.slice(pos + 1);
        } else {
            deshn = '';
        }
    }

    const path = matches[2] || '';
    let pattern =
            des
                .replace(/\*/g, '[\\w.%-]*')
                .replace(/\./g, '\\.') +
            path
                .replace(/[.+?{}()|[\]\/\\]/g, '\\$&')
                .replace(/\^/g, '[^\\w.%-]')
                .replace(/\*/g, '.*?');
    if ( pattern === '' ) {
        pattern = '^';
    }

    let type,
        redirect = '',
        srchns = [];
    for ( const option of matches[3].split(',') ) {
        if ( option.startsWith('redirect=') ) {
            redirect = option.slice(9);
            continue;
        }
        if ( option.startsWith('redirect-rule=') ) {
            redirect = option.slice(14);
            continue;
        }
        if ( option.startsWith('domain=') ) {
            srchns = option.slice(7).split('|');
            continue;
        }
        if ( option.startsWith('from=') ) {
            srchns = option.slice(5).split('|');
            continue;
        }
        if ( (option === 'first-party' || option === '1p') && deshn !== '' ) {
            srchns.push(µBlock.URI.domainFromHostname(deshn) || deshn);
            continue;
        }
        // One and only one type must be specified.
        if ( this.supportedTypes.has(option) ) {
            if ( type !== undefined ) { return; }
            type = this.supportedTypes.get(option);
            continue;
        }
    }

    // Need a resource token.
    if ( redirect === '' ) { return; }

    // Need one single type -- not negated.
    if ( type === undefined ) { return; }

    if ( deshn === '' ) {
        deshn = '*';
    }

    if ( srchns.length === 0 ) {
        srchns.push('*');
    }

    const out = [];
    for ( const srchn of srchns ) {
        if ( srchn === '' ) { continue; }
        if ( srchn.startsWith('~') ) { continue; }
        out.push(`${srchn}\t${deshn}\t${type}\t${pattern}\t${redirect}`);
    }

    if ( out.length === 0 ) { return; }

    return out;
};

/******************************************************************************/

RedirectEngine.prototype.reFilterParser = /^(?:\|\|([^\/:?#^]+)|\*?)([^$]+)?\$([^$]+)$/;

RedirectEngine.prototype.supportedTypes = new Map([
    [ 'css', 'stylesheet' ],
    [ 'font', 'font' ],
    [ 'image', 'image' ],
    [ 'media', 'media' ],
    [ 'object', 'object' ],
    [ 'script', 'script' ],
    [ 'stylesheet', 'stylesheet' ],
    [ 'frame', 'sub_frame' ],
    [ 'subdocument', 'sub_frame' ],
    [ 'xhr', 'xmlhttprequest' ],
    [ 'xmlhttprequest', 'xmlhttprequest' ],
]);

/******************************************************************************/

RedirectEngine.prototype.toSelfie = function() {
    // Because rules may contains RegExp instances, we need to manually
    // convert it to a serializable format. The serialized format must be
    // suitable to be used as an argument to the Map() constructor.
    var rules = [],
        rule, entries, i, entry;
    for ( var item of this.rules ) {
        rule = [ item[0], [] ];
        entries = item[1];
        i = entries.length;
        while ( i-- ) {
            entry = entries[i];
            rule[1].push({
                tok: entry.tok,
                pat: entry.pat instanceof RegExp ? entry.pat.source : entry.pat
            });
        }
        rules.push(rule);
    }
    var µb = µBlock;
    return {
        rules: rules,
        ruleTypes: µb.arrayFrom(this.ruleTypes),
        ruleSources: µb.arrayFrom(this.ruleSources),
        ruleDestinations: µb.arrayFrom(this.ruleDestinations)
    };
};

/******************************************************************************/

RedirectEngine.prototype.fromSelfie = function(selfie) {
    this.rules = new Map(selfie.rules);
    this.ruleTypes = new Set(selfie.ruleTypes);
    this.ruleSources = new Set(selfie.ruleSources);
    this.ruleDestinations = new Set(selfie.ruleDestinations);
    this._desAll = []; // re-use better than re-allocate
    this.modifyTime = Date.now();
    return true;
};

/******************************************************************************/

RedirectEngine.prototype.resourceURIFromName = function(name, mime) {
    const entry = this.resources.get(this.aliases.get(name) || name);
    if ( entry && (mime === undefined || entry.mime.startsWith(mime)) ) {
        return entry.toURL();
    }
};

/******************************************************************************/

RedirectEngine.prototype.resourceContentFromName = function(name, mime) {
    const entry = this.resources.get(this.aliases.get(name) || name);
    if ( entry === undefined ) { return; }
    if ( mime === undefined || entry.mime.startsWith(mime) ) {
        return entry.toContent();
    }
};

/******************************************************************************/

// TODO: combine same key-redirect pairs into a single regex.

// https://github.com/uBlockOrigin/uAssets/commit/deefe875551197d655f79cb540e62dfc17c95f42
//   Consider 'none' a reserved keyword, to be used to disable redirection.

RedirectEngine.prototype.resourcesFromString = function(text) {
    let   fields, encoded, aliasLineCount = 0;
    const reNonEmptyLine = /\S/,
          lineIter = new µBlock.LineIterator(text);

    this.aliases = new Map();
    this.resources = new Map();

    for ( let i = 0; lineIter.eot() === false; i++ ) {
        const line = lineIter.next();
        if ( line.startsWith('#') ) { continue; }

        if ( fields === undefined ) {
            const head = line.trim().split(/\s+/);
            if ( head.length !== 2 ) { continue; }
            if ( head[0] === 'none' ) { continue; }
            encoded = head[1].indexOf(';') !== -1;
            fields = head;
            aliasLineCount = i;
            continue;
        }

        // Legitimate part of data could start with 'alias '.
        // We're past aliases part if apart for more than 1 line
        // from when we last processed resource's head.
        if ( i - aliasLineCount === 1 ) {
            const data = line.trim().split(/\s+/);
            if ( data.length === 2 && data[0] === 'alias' ) {
                this.aliases.set(data[1], fields[0]);
                aliasLineCount = i;
                continue;
            }
        }

        if ( reNonEmptyLine.test(line) ) {
            fields.push(encoded ? line.trim() : line);
            continue;
        }

        // No more data, add the resource.
        this.resources.set(
            fields[0],
            RedirectEntry.fromFields(fields[1], fields.slice(2))
        );

        fields = undefined;
    }

    // Process pending resource data.
    if ( fields !== undefined ) {
        this.resources.set(
            fields[0],
            RedirectEntry.fromFields(fields[1], fields.slice(2))
        );
    }

    warResolve();

    this.modifyTime = Date.now();
};

/******************************************************************************/

const resourcesSelfieVersion = 4;

RedirectEngine.prototype.selfieFromResources = function() {
    vAPI.cacheStorage.set({
        resourcesSelfie: {
            version: resourcesSelfieVersion,
            aliases: µBlock.arrayFrom(this.aliases),
            resources: µBlock.arrayFrom(this.resources)
        }
    });
};

RedirectEngine.prototype.resourcesFromSelfie = function(callback) {
    vAPI.cacheStorage.get('resourcesSelfie', bin => {
        if ( bin instanceof Object === false ) {
            return callback(false);
        }
        const selfie = bin.resourcesSelfie;
        if (
            selfie instanceof Object === false ||
            selfie.version !== resourcesSelfieVersion ||
            Array.isArray(selfie.resources) === false
        ) {
            return callback(false);
        }
        this.aliases = new Map();
        for ( const entry of bin.resourcesSelfie.aliases ) {
            this.aliases.set(entry[0], entry[1]);
        }
        this.resources = new Map();
        for ( const entry of bin.resourcesSelfie.resources ) {
            this.resources.set(entry[0], RedirectEntry.fromSelfie(entry[1]));
        }
        callback(true);
    });
};

RedirectEngine.prototype.invalidateResourcesSelfie = function() {
    vAPI.cacheStorage.remove('resourcesSelfie');
};

/******************************************************************************/
/******************************************************************************/

return new RedirectEngine();

/******************************************************************************/

})();
