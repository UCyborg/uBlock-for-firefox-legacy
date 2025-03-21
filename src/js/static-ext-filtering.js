/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2017-present Raymond Hill

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

/* global punycode */

'use strict';

/*******************************************************************************

  All static extended filters are of the form:

  field 1: one hostname, or a list of comma-separated hostnames
  field 2: `##` or `#@#`
  field 3: selector

  The purpose of the static extended filtering engine is to coarse-parse and
  dispatch to appropriate specialized filtering engines. There are currently
  three specialized filtering engines:

  - cosmetic filtering (aka "element hiding" in Adblock Plus)
  - scriptlet injection: selector starts with `script:inject`
    - New shorter syntax (1.15.12): `example.com##+js(bab-defuser.js)`
  - html filtering: selector starts with `^`

  Depending on the specialized filtering engine, field 1 may or may not be
  optional.

  The static extended filtering engine also offers parsing capabilities which
  are available to all other specialized fitlering engines. For example,
  cosmetic and html filtering can ask the extended filtering engine to
  compile/validate selectors.

**/

µBlock.staticExtFilteringEngine = (function() {
    const µb = µBlock;
    const reHasUnicode = /[^\x00-\x7F]/;
    const reParseRegexLiteral = /^\/(.+)\/([imu]+)?$/;
    const reSimpleSelector = /^[#.][A-Za-z_][\w-]*$/;
    const emptyArray = [];
    const parsed = {
        hostnames: [],
        exception: false,
        suffix: ''
    };

    const div = (( ) => {
        if ( typeof document !== 'object' ) { return null; }
        if ( document instanceof Object === false ) { return null; }
        return document.createElement('div');
    })();

    // https://developer.mozilla.org/en-US/docs/Web/API/CSSStyleSheet#browser_compatibility
    //   Firefox does not support constructor for CSSStyleSheet
    const stylesheet = (( ) => {
        if ( typeof document !== 'object' ) { return null; }
        if ( document instanceof Object === false ) { return null; }
        try {
            return new CSSStyleSheet();
        } catch(ex) {
        }
        const style = document.createElement('style');
        document.body.append(style);
        const stylesheet = style.sheet;
        style.remove();
        return stylesheet;
    })();

    // To be called to ensure no big parent string of a string slice is
    // left into memory after parsing filter lists is over.
    const resetParsed = function() {
        parsed.hostnames = [];
        parsed.suffix = '';
    };

    // https://github.com/uBlockOrigin/uBlock-issues/issues/1806
    //   Forbid instances of:
    //   - opening comment `/*`
    const querySelectable = function(s) {
        if ( reSimpleSelector.test(s) ) { return true; }
        if ( div === null ) { return true; }
        try {
            div.querySelector(`${s},${s}:not(#foo)`);
            if ( s.includes('/*') ) { return false; }
        } catch (ex) {
            return false;
        }
        return true;
    };

    // Quick regex-based validation -- most cosmetic filters are of the
    // simple form and in such case a regex is much faster.
    // Keep in mind:
    //   https://github.com/gorhill/uBlock/issues/693
    //   https://github.com/gorhill/uBlock/issues/1955
    // https://github.com/gorhill/uBlock/issues/3111
    //   Workaround until https://bugzilla.mozilla.org/show_bug.cgi?id=1406817
    //   is fixed.
    // https://github.com/uBlockOrigin/uBlock-issues/issues/1751
    //   Do not rely on matches() or querySelector() to test whether a
    //   selector is declarative or not.
    // https://github.com/uBlockOrigin/uBlock-issues/issues/1806#issuecomment-963278382
    //   Forbid multiple and unexpected CSS style declarations.
    const sheetSelectable = function(s) {
        if ( reSimpleSelector.test(s) ) { return true; }
        if ( stylesheet === null ) { return true; }
        try {
            stylesheet.insertRule(`${s}{color:red}`);
            if ( stylesheet.cssRules.length !== 1 ) { return false; }
            const style = stylesheet.cssRules[0].style;
            if ( style.length !== 1 ) { return false; }
            if ( style.getPropertyValue('color') !== 'red' ) { return false; }
            stylesheet.deleteRule(0);
        } catch (ex) {
            return false;
        }
        return true;
    };


    const isBadRegex = function(s) {
        try {
            void new RegExp(s);
        } catch (ex) {
            isBadRegex.message = ex.toString();
            return true;
        }
        return false;
    };

    const translateAdguardCSSInjectionFilter = function(suffix) {
        const matches = /^([^{]+)\{([^}]+)\}$/.exec(suffix);
        if ( matches === null ) { return ''; }
        const selector = matches[1].trim();
        const style = matches[2].trim();
        // Special style directive `remove: true` is converted into a
        // `:remove()` operator.
        if ( /^\s*remove:\s*true[; ]*$/.test(style) ) {
            return `${selector}:remove()`;
        }
        // For some reasons, many of Adguard's plain cosmetic filters are
        // "disguised" as style-based cosmetic filters: convert such filters
        // to plain cosmetic filters.
        return /display\s*:\s*none\s*!important;?$/.test(style)
            ? selector
            : `${selector}:style(${style})`;
    };

    const hostnamesFromPrefix = function(s) {
        const hostnames = [];
        const hasUnicode = reHasUnicode.test(s);
        let beg = 0;
        while ( beg < s.length ) {
            let end = s.indexOf(',', beg);
            if ( end === -1 ) { end = s.length; }
            let hostname = s.slice(beg, end).trim();
            if ( hostname.length !== 0 ) {
                if ( hasUnicode ) {
                    hostname = hostname.charCodeAt(0) === 0x7E /* '~' */
                        ? '~' + punycode.toASCII(hostname.slice(1))
                        : punycode.toASCII(hostname);
                }
                hostnames.push(hostname);
            }
            beg = end + 1;
        }
        return hostnames;
    };

    const compileProceduralSelector = (( ) => {
        const reProceduralOperator = new RegExp([
            '^(?:',
                [
                '-abp-contains',
                '-abp-has',
                'contains',
                'has',
                'has-text',
                'if',
                'if-not',
                'matches-css',
                'matches-css-after',
                'matches-css-before',
                'min-text-length',
                'not',
                'nth-ancestor',
                'remove',
                'style',
                'upward',
                'watch-attr',
                'watch-attrs',
                'xpath'
                ].join('|'),
            ')\\('
        ].join(''));

        const reEatBackslashes = /\\([()])/g;
        const reEscapeRegex = /[.*+?^${}()|[\]\\]/g;
        const reNeedScope = /^\s*>/;
        const reIsDanglingSelector = /[+>~\s]\s*$/;
        const reIsSiblingSelector = /^\s*[+~]/;

        const regexToRawValue = new Map();
        let lastProceduralSelector = '',
            lastProceduralSelectorCompiled;

        // When dealing with literal text, we must first eat _some_
        // backslash characters.
        const compileText = function(s) {
            const match = reParseRegexLiteral.exec(s);
            let regexDetails;
            if ( match !== null ) {
                regexDetails = match[1];
                if ( isBadRegex(regexDetails) ) { return; }
                if ( match[2] ) {
                    regexDetails = [ regexDetails, match[2] ];
                }
            } else {
                regexDetails = s.replace(reEatBackslashes, '$1')
                                .replace(reEscapeRegex, '\\$&');
                regexToRawValue.set(regexDetails, s);
            }
            return regexDetails;
        };

        const compileCSSDeclaration = function(s) {
            const pos = s.indexOf(':');
            if ( pos === -1 ) { return; }
            const name = s.slice(0, pos).trim();
            const value = s.slice(pos + 1).trim();
            const match = reParseRegexLiteral.exec(value);
            let regexDetails;
            if ( match !== null ) {
                regexDetails = match[1];
                if ( isBadRegex(regexDetails) ) { return; }
                if ( match[2] ) {
                    regexDetails = [ regexDetails, match[2] ];
                }
            } else {
                regexDetails = '^' + value.replace(reEscapeRegex, '\\$&') + '$';
                regexToRawValue.set(regexDetails, value);
            }
            return { name: name, value: regexDetails };
        };

        const compileConditionalSelector = function(s) {
            // https://github.com/AdguardTeam/ExtendedCss/issues/31#issuecomment-302391277
            //   Prepend `:scope ` if needed.
            if ( reNeedScope.test(s) ) {
                s = `:scope ${s}`;
            }
            return compile(s);
        };

        const compileInteger = function(s, min = 0, max = 0x7FFFFFFF) {
            if ( /^\d+$/.test(s) === false ) { return; }
            const n = parseInt(s, 10);
            if ( n < min || n >= max ) { return; }
            return n;
        };

        const compileNotSelector = function(s) {
            // https://github.com/uBlockOrigin/uBlock-issues/issues/341#issuecomment-447603588
            //   Reject instances of :not() filters for which the argument is
            //   a valid CSS selector, otherwise we would be adversely
            //   changing the behavior of CSS4's :not().
            if ( sheetSelectable(s) === false ) {
                return compileConditionalSelector(s);
            }
        };

        const compileUpwardArgument = function(s) {
            const i = compileInteger(s, 1, 256);
            if ( i !== undefined ) { return i; }
            if ( sheetSelectable(s) ) { return s; }
        };

        const compileRemoveSelector = function(s) {
            if ( s === '' ) { return s; }
        };

        const compileSpathExpression = function(s) {
            if ( sheetSelectable('*' + s) ) {
                return s;
            }
        };


        const compileStyleProperties = function(s) {
            // https://github.com/uBlockOrigin/uBlock-issues/issues/668
            // https://github.com/uBlockOrigin/uBlock-issues/issues/1693
            // https://github.com/uBlockOrigin/uBlock-issues/issues/1811
            //   Forbid instances of:
            //   - `image-set(`
            //   - `url(`
            //   - any instance of `//`
            //   - backslashes `\`
            //   - opening comment `/*`
            if ( /image-set\(|url\(|\/\s*\/|\\|\/\*/i.test(s) ) { return; }
            if ( stylesheet === null ) { return s; }
            let valid = false;
            try {
                stylesheet.insertRule(`a{${s}}`);
                const rules = stylesheet.cssRules;
                valid = rules.length !== 0 && rules[0].style.cssText !== '';
            } catch(ex) {
                return;
            }
            if ( stylesheet.cssRules.length !== 0 ) {
                stylesheet.deleteRule(0);
            }
            if ( valid ) { return s; }
        };

        const compileAttrList = function(s) {
            const attrs = s.split('\s*,\s*');
            const out = [];
            for ( let attr of attrs ) {
                if ( attr !== '' ) {
                    out.push(attr);
                }
            }
            return out;
        };

        const compileXpathExpression = function(s) {
            try {
                document.createExpression(s, null);
            } catch (e) {
                return;
            }
            return s;
        };

        // https://github.com/gorhill/uBlock/issues/2793
        const normalizedOperators = new Map([
            [ ':-abp-contains', ':has-text' ],
            [ ':-abp-has', ':has' ],
            [ ':contains', ':has-text' ],
            [ ':nth-ancestor', ':upward' ],
            [ ':watch-attrs', ':watch-attr' ],
        ]);

        const compileArgument = new Map([
            [ ':has', compileConditionalSelector ],
            [ ':has-text', compileText ],
            [ ':if', compileConditionalSelector ],
            [ ':if-not', compileConditionalSelector ],
            [ ':matches-css', compileCSSDeclaration ],
            [ ':matches-css-after', compileCSSDeclaration ],
            [ ':matches-css-before', compileCSSDeclaration ],
            [ ':min-text-length', compileInteger ],
            [ ':not', compileNotSelector ],
            [ ':remove', compileRemoveSelector ],
            [ ':spath', compileSpathExpression ],
            [ ':style', compileStyleProperties ],
            [ ':upward', compileUpwardArgument ],
            [ ':watch-attr', compileAttrList ],
            [ ':xpath', compileXpathExpression ]
        ]);

        const actionOperators = new Set([
            ':remove',
            ':style',
        ]);

        // https://github.com/gorhill/uBlock/issues/2793#issuecomment-333269387
        //   Normalize (somewhat) the stringified version of procedural
        //   cosmetic filters -- this increase the likelihood of detecting
        //   duplicates given that uBO is able to understand syntax specific
        //   to other blockers.
        //   The normalized string version is what is reported in the logger,
        //   by design.
        const decompile = function(compiled) {
            const tasks = compiled.tasks;
            if ( Array.isArray(tasks) === false ) {
                return compiled.selector;
            }
            const raw = [ compiled.selector ];
            let value;
            for ( let task of tasks ) {
                switch ( task[0] ) {
                case ':has':
                case ':if':
                    raw.push(`:has(${decompile(task[1])})`);
                    break;
                case ':has-text':
                    if ( Array.isArray(task[1]) ) {
                        value = `/${task[1][0]}/${task[1][1]}`;
                    } else {
                        value = regexToRawValue.get(task[1]);
                        if ( value === undefined ) {
                            value = `/${task[1]}/`;
                        }
                    }
                    raw.push(`:has-text(${value})`);
                    break;
                case ':matches-css':
                case ':matches-css-after':
                case ':matches-css-before':
                    if ( Array.isArray(task[1].value) ) {
                        value = `/${task[1].value[0]}/${task[1].value[1]}`;
                    } else {
                        value = regexToRawValue.get(task[1].value);
                        if ( value === undefined ) {
                            value = `/${task[1].value}/`;
                        }
                    }
                    raw.push(`${task[0]}(${task[1].name}: ${value})`);
                    break;
                case ':not':
                case ':if-not':
                    raw.push(`:not(${decompile(task[1])})`);
                    break;
                case ':spath':
                    raw.push(task[1]);
                    break;
                case ':min-text-length':
                case ':remove':
                case ':style':
                case ':upward':
                case ':watch-attr':
                case ':xpath':
                    raw.push(`${task[0]}(${task[1]})`);
                    break;
                }
            }
            return raw.join('');
        };

        const compile = function(raw, root = false) {
            if ( raw === '' ) { return; }

            const tasks = [];
            const n = raw.length;
            let prefix = '';
            let i = 0;
            let opPrefixBeg = 0;
            let action;

            for (;;) {
                let c, match;
                // Advance to next operator.
                while ( i < n ) {
                    c = raw.charCodeAt(i++);
                    if ( c === 0x3A /* ':' */ ) {
                        match = reProceduralOperator.exec(raw.slice(i));
                        if ( match !== null ) { break; }
                    }
                }
                if ( i === n ) { break; }
                const opNameBeg = i - 1;
                const opNameEnd = i + match[0].length - 1;
                i += match[0].length;
                // Find end of argument: first balanced closing parenthesis.
                // Note: unbalanced parenthesis can be used in a regex literal
                // when they are escaped using `\`.
                // TODO: need to handle quoted parentheses.
                let pcnt = 1;
                while ( i < n ) {
                    c = raw.charCodeAt(i++);
                    if ( c === 0x5C /* '\\' */ ) {
                        if ( i < n ) { i += 1; }
                    } else if ( c === 0x28 /* '(' */ ) {
                        pcnt +=1 ;
                    } else if ( c === 0x29 /* ')' */ ) {
                        pcnt -= 1;
                        if ( pcnt === 0 ) { break; }
                    }
                }
                // Unbalanced parenthesis? An unbalanced parenthesis is fine
                // as long as the last character is a closing parenthesis.
                if ( pcnt !== 0 && c !== 0x29 ) { return; }
                // https://github.com/uBlockOrigin/uBlock-issues/issues/341#issuecomment-447603588
                //   Maybe that one operator is a valid CSS selector and if so,
                //   then consider it to be part of the prefix.
                if ( sheetSelectable(raw.slice(opNameBeg, i)) ) {
                    continue;
                }
                // Extract and remember operator details.
                let operator = raw.slice(opNameBeg, opNameEnd);
                operator = normalizedOperators.get(operator) || operator;
                // Action operator can only be used as trailing operator in the
                // root task list.
                // Per-operator arguments validation
                const args = compileArgument.get(operator)(
                    raw.slice(opNameEnd + 1, i - 1)
                );
                if ( args === undefined ) { return; }
                if ( opPrefixBeg === 0 ) {
                    prefix = raw.slice(0, opNameBeg);
                } else if ( opNameBeg !== opPrefixBeg ) {
                    if ( action !== undefined ) { return; }
                    const spath = compileSpathExpression(
                        raw.slice(opPrefixBeg, opNameBeg)
                    );
                    if ( spath === undefined ) { return; }
                    tasks.push([ ':spath', spath ]);
                }
                if ( action !== undefined ) { return; }
                tasks.push([ operator, args ]);
                if ( actionOperators.has(operator) ) {
                    if ( root === false ) { return; }
                    action = operator.slice(1);
                }
                opPrefixBeg = i;
                if ( i === n ) { break; }
            }

            // No task found: then we have a CSS selector.
            // At least one task found: nothing should be left to parse.
            if ( tasks.length === 0 ) {
                if ( action === undefined ) {
                    prefix = raw;
                }
                if ( root && sheetSelectable(prefix) ) {
                    if ( action === undefined ) {
                        return { selector: prefix };
                    } else if ( action[0] === ':style' ) {
                        return { selector: prefix, action };
                    }
                }

            } else if ( opPrefixBeg < n ) {
                if ( action !== undefined ) { return; }
                const spath = compileSpathExpression(raw.slice(opPrefixBeg));
                if ( spath === undefined ) { return; }
                tasks.push([ ':spath', spath ]);
            }

            // https://github.com/NanoAdblocker/NanoCore/issues/1#issuecomment-354394894
            // https://www.reddit.com/r/uBlockOrigin/comments/c6iem5/
            //   Convert sibling-selector prefix into :spath operator, but
            //   only if context is not the root.
            if ( prefix !== '' ) {
                if ( reIsDanglingSelector.test(prefix) ) { prefix += '*'; }
                if ( sheetSelectable(prefix) === false ) {
                    if (
                        root ||
                        reIsSiblingSelector.test(prefix) === false ||
                        compileSpathExpression(prefix) === undefined
                    ) {
                        return;
                    }
                    tasks.unshift([ ':spath', prefix ]);
                    prefix = '';
                }
            }

            const out = { selector: prefix };

            if ( tasks.length !== 0 ) {
                out.tasks = tasks;
            }

            // Expose action to take in root descriptor.
            if ( action !== undefined ) {
                out.action = action;
            }

            return out;
        };

        const entryPoint = function(raw) {
            if ( raw === lastProceduralSelector ) {
                return lastProceduralSelectorCompiled;
            }
            lastProceduralSelector = raw;
            let compiled = compile(raw, true);
            if ( compiled !== undefined ) {
                compiled.raw = decompile(compiled);
            }
            lastProceduralSelectorCompiled = compiled;
            return compiled;
        };

        entryPoint.reset = function() {
            regexToRawValue.clear();
            lastProceduralSelector = '';
            lastProceduralSelectorCompiled = undefined;
        };

        return entryPoint;
    })();

    //--------------------------------------------------------------------------
    // Public API
    //--------------------------------------------------------------------------

    const api = {
        get acceptedCount() {
            return µb.cosmeticFilteringEngine.acceptedCount +
                   µb.scriptletFilteringEngine.acceptedCount +
                   µb.htmlFilteringEngine.acceptedCount;
        },
        get discardedCount() {
            return µb.cosmeticFilteringEngine.discardedCount +
                   µb.scriptletFilteringEngine.discardedCount +
                   µb.htmlFilteringEngine.discardedCount;
        },
    };

    //--------------------------------------------------------------------------
    // Public classes
    //--------------------------------------------------------------------------

    api.HostnameBasedDB = function(selfie) {
        if ( selfie !== undefined ) {
            this.db = new Map(selfie.map);
            this.size = selfie.size;
        } else {
            this.db = new Map();
            this.size = 0;
        }
    };

    api.HostnameBasedDB.prototype = {
        add: function(hash, entry) {
            var bucket = this.db.get(hash);
            if ( bucket === undefined ) {
                this.db.set(hash, entry);
            } else if ( Array.isArray(bucket) ) {
                bucket.push(entry);
            } else {
                this.db.set(hash, [ bucket, entry ]);
            }
            this.size += 1;
        },
        clear: function() {
            this.db.clear();
            this.size = 0;
        },
        retrieve: function(hash, hostname, out) {
            var bucket = this.db.get(hash);
            if ( bucket === undefined ) { return; }
            if ( Array.isArray(bucket) === false ) {
                if ( hostname.endsWith(bucket.hostname) ) { out.push(bucket); }
                return;
            }
            var i = bucket.length;
            while ( i-- ) {
                var entry = bucket[i];
                if ( hostname.endsWith(entry.hostname) ) { out.push(entry); }
            }
        },
        toSelfie: function() {
            return {
                map: Array.from(this.db),
                size: this.size
            };
        }
    };

    api.HostnameBasedDB.prototype[Symbol.iterator] = (function() {
        const Iter = function(db) {
            this.mapIter = db.values();
            this.arrayIter = undefined;
        };
        Iter.prototype.next = function() {
            let result;
            if ( this.arrayIter !== undefined ) {
                result = this.arrayIter.next();
                if ( result.done === false ) { return result; }
                this.arrayIter = undefined;
            }
            result = this.mapIter.next();
            if ( result.done || Array.isArray(result.value) === false ) {
                return result;
            }
            this.arrayIter = result.value[Symbol.iterator]();
            return this.arrayIter.next(); // array should never be empty
        };
        return function() {
            return new Iter(this.db);
        };
    })();

    //--------------------------------------------------------------------------
    // Public methods
    //--------------------------------------------------------------------------

    api.reset = function() {
        compileProceduralSelector.reset();
        µb.cosmeticFilteringEngine.reset();
        µb.scriptletFilteringEngine.reset();
        µb.htmlFilteringEngine.reset();
        resetParsed(parsed);
    };

    api.freeze = function() {
        compileProceduralSelector.reset();
        µb.cosmeticFilteringEngine.freeze();
        µb.scriptletFilteringEngine.freeze();
        µb.htmlFilteringEngine.freeze();
        resetParsed(parsed);
    };

    // https://github.com/chrisaljoudi/uBlock/issues/1004
    // Detect and report invalid CSS selectors.

    // Discard new ABP's `-abp-properties` directive until it is
    // implemented (if ever). Unlikely, see:
    // https://github.com/gorhill/uBlock/issues/1752

    // https://github.com/gorhill/uBlock/issues/2624
    // Convert Adguard's `-ext-has='...'` into uBO's `:has(...)`.

    api.compileSelector = (function() {
        const reExtendedSyntax = /\[-(?:abp|ext)-[a-z-]+=(['"])(?:.+?)(?:\1)\]/;
        const reExtendedSyntaxParser = /\[-(?:abp|ext)-([a-z-]+)=(['"])(.+?)\2\]/;

        const normalizedExtendedSyntaxOperators = new Map([
            [ 'contains', ':has-text' ],
            [ 'has', ':has' ],
            [ 'matches-css', ':matches-css' ],
            [ 'matches-css-after', ':matches-css-after' ],
            [ 'matches-css-before', ':matches-css-before' ],
        ]);

        const entryPoint = function(raw) {
            const extendedSyntax = reExtendedSyntax.test(raw);
            if ( sheetSelectable(raw) && extendedSyntax === false ) {
                return raw;
            }

            // We  rarely reach this point -- majority of selectors are plain
            // CSS selectors.

            // Supported Adguard/ABP advanced selector syntax: will translate
            // into uBO's syntax before further processing.
            // Mind unsupported advanced selector syntax, such as ABP's
            // `-abp-properties`.
            // Note: extended selector syntax has been deprecated in ABP, in
            // favor of the procedural one (i.e. `:operator(...)`).
            // See https://issues.adblockplus.org/ticket/5287
            if ( extendedSyntax ) {
                let matches;
                while ( (matches = reExtendedSyntaxParser.exec(raw)) !== null ) {
                    const operator = normalizedExtendedSyntaxOperators.get(matches[1]);
                    if ( operator === undefined ) { return; }
                    raw = raw.slice(0, matches.index) +
                          operator + '(' + matches[3] + ')' +
                          raw.slice(matches.index + matches[0].length);
                }
                return entryPoint(raw);
            }

            // Procedural selector?
            const compiled = compileProceduralSelector(raw);
            if ( compiled === undefined ) { return; }

            return compiled.selector !== compiled.raw ||
                   sheetSelectable(compiled.selector) === false
                       ? JSON.stringify(compiled)
                       : compiled.selector;
        };

        return entryPoint;
    })();

    api.compile = function(raw, writer) {
        let lpos = raw.indexOf('#');
        if ( lpos === -1 ) { return false; }
        let rpos = lpos + 1;
        if ( raw.charCodeAt(rpos) !== 0x23 /* '#' */ ) {
            rpos = raw.indexOf('#', rpos + 1);
            if ( rpos === -1 ) { return false; }
        }

        // https://github.com/AdguardTeam/AdguardFilters/commit/4fe02d73cee6
        //   AdGuard also uses `$?` to force inline-based style rather than
        //   stylesheet-based style.
        // Coarse-check that the anchor is valid.
        // `##`: l === 1
        // `#@#`, `#$#`, `#%#`, `#?#`: l === 2
        // `#@$#`, `#@%#`, `#@?#`, `#$?#`: l === 3
        // `#@$?#`: l === 4
        const anchorLen = rpos - lpos;
        if ( anchorLen > 4 ) { return false; }
        if (
            anchorLen > 1 &&
            /^@?(?:\$\??|%|\?)?$/.test(raw.slice(lpos + 1, rpos)) === false
        ) {
            return false;
        }

        // Extract the selector.
        let suffix = raw.slice(rpos + 1).trim();
        if ( suffix.length === 0 ) { return false; }
        parsed.suffix = suffix;

        // https://github.com/gorhill/uBlock/issues/952
        //   Find out whether we are dealing with an Adguard-specific cosmetic
        //   filter, and if so, translate it if supported, or discard it if not
        //   supported.
        //   We have an Adguard/ABP cosmetic filter if and only if the
        //   character is `$`, `%` or `?`, otherwise it's not a cosmetic
        //   filter.
        let cCode = raw.charCodeAt(rpos - 1);
        if ( cCode !== 0x23 /* '#' */ && cCode !== 0x40 /* '@' */ ) {
            // Adguard's scriptlet injection: not supported.
            if ( cCode === 0x25 /* '%' */ ) { return true; }
            if ( cCode === 0x3F /* '?' */ && anchorLen > 2 ) {
                cCode = raw.charCodeAt(rpos - 2);
            }
            // Adguard's style injection: translate to uBO's format.
            if ( cCode === 0x24 /* '$' */ ) {
                suffix = translateAdguardCSSInjectionFilter(suffix);
                if ( suffix === '' ) { return true; }
                parsed.suffix = suffix;
            }
        }

        // Exception filter?
        parsed.exception = raw.charCodeAt(lpos + 1) === 0x40 /* '@' */;

        // Extract the hostname(s), punycode if required.
        if ( lpos === 0 ) {
            parsed.hostnames = emptyArray;
        } else {
            parsed.hostnames = hostnamesFromPrefix(raw.slice(0, lpos));
        }

        // Backward compatibility with deprecated syntax.
        if ( suffix.startsWith('script:') ) {
            if ( suffix.startsWith('script:inject') ) {
                suffix = parsed.suffix = '+js' + suffix.slice(13);
            } else if ( suffix.startsWith('script:contains') ) {
                suffix = parsed.suffix = '^script:has-text' + suffix.slice(15);
            }
        }

        let c0 = suffix.charCodeAt(0);

        // New shorter syntax for scriptlet injection engine.
        if ( c0 === 0x2B /* '+' */ && suffix.startsWith('+js') ) {
            µb.scriptletFilteringEngine.compile(parsed, writer);
            return true;
        }

        // HTML filtering engine.
        // TODO: evaluate converting Adguard's `$$` syntax into uBO's HTML
        //       filtering syntax.
        if ( c0 === 0x5E /* '^' */ ) {
            µb.htmlFilteringEngine.compile(parsed, writer);
            return true;
        }

        // Cosmetic filtering engine.
        µb.cosmeticFilteringEngine.compile(parsed, writer);
        return true;
    };

    api.fromCompiledContent = function(reader, options) {
        µb.cosmeticFilteringEngine.fromCompiledContent(reader, options);
        µb.scriptletFilteringEngine.fromCompiledContent(reader, options);
        µb.htmlFilteringEngine.fromCompiledContent(reader, options);
    };

    api.toSelfie = function() {
        return {
            cosmetic: µb.cosmeticFilteringEngine.toSelfie(),
            scriptlets: µb.scriptletFilteringEngine.toSelfie(),
            html: µb.htmlFilteringEngine.toSelfie()
        };
    };

    api.fromSelfie = function(selfie) {
        µb.cosmeticFilteringEngine.fromSelfie(selfie.cosmetic);
        µb.scriptletFilteringEngine.fromSelfie(selfie.scriptlets);
        µb.htmlFilteringEngine.fromSelfie(selfie.html);
    };

    return api;
})();

/******************************************************************************/
