package('sriku.wireup.system', ['#global', 'Kinetic'], function (G, Kinetic) {

/////////////////////////////////////////////////////

function replaceAll(str, pat, subst) {
    while (str.indexOf(pat) >= 0) {
        str = str.replace(pat, subst);
    }
    return str;
}

// Returns the instantiated inlined code of the operator.
function code(op) {
    var codeRE = /^[^\{]+\{((.|\n|\r)*)\}$/;
    var template = codeRE.exec(op.operator.toString())[1];
    var inputs = Object.keys(op.ain);
    var outputs = Object.keys(op.aout);
    var mems = Object.keys(op.mem);
    var locals = op.locals;

    var pats = [];

    inputs.forEach(function (i) {
        pats.push(['ain.' + i, op.ain[i]]);
    });
    outputs.forEach(function (i) {
        pats.push(['aout.' + i, op.aout[i]]);
    });
    mems.forEach(function (i) {
        pats.push(['mem.' + i, op.mem[i]]);
    });

    // Remove the var declarations. They'll be lifted.
    var varDecl = /\bvar\b[^;]+;/g;
    while (varDecl.test(template)) {
        template = template.replace(varDecl, '');
    }

    // Rename the local variables.
    locals.forEach(function (v) {
        var re = new RegExp('\\b' + v.used + '\\b', 'g');
        while (re.test(template)) {
            template = template.replace(re, v.renamed);
        }
    });

    // Sort in reverse order of length so that common prefixes
    // don't cause confusion.
    pats.sort(function (p1, p2) { return p2[1].length - p1[1].length; });

    pats.forEach(function (p) {
        template = replaceAll(template, p[0], p[1]);
    });
    
    return template;
}

// Returns an object whose keys are variable names used in the code and
// whose values are variable identifiers. 'name' is the category of
// variables to extract, such as 'ain', 'aout' and 'mem'.
function variables(name, str) {
    var re = new RegExp(name + '\\.([a-zA-Z_][a-zA-Z_0-9]*)', 'g');
    var nameVar = {}, varname, vartype;
    var match = null;
    while (match = re.exec(str)) {
        if (!(match[1] in nameVar)) {
            varname = name + '_' + match[1] + '_' + (variables.count++);
            nameVar[match[1]] = varname;
        }
    }
    return nameVar;    
}

// Local variables are lifted. You can only use the following form -
//      var name1, name2, ... ;
// without initializers. Semicolon is a must.
function localVariables(str) {
    var re = /\bvar\b([^;]+);/g;
    var m;
    var vars = [];

    while (m = re.exec(str)) {
        vars.push.apply(vars, m[1].split(',').map(function (s) { 
            s = s.trim();
            return {used: s, renamed: 'local_' + s};
        }));
    }

    return vars;
}

variables.count = 1;

// Instantiates an operator.
function block(op, init_args) {
    var expr        = op.toString();
    var obj         = Object.create(op.prototype);
    
    obj.operator    = op;
    obj.ain         = variables('ain', expr);
    obj.aout        = variables('aout', expr);
    obj.mem         = variables('mem', expr);
    obj.locals      = localVariables(expr);
    obj.setup       = {};
    obj.init_args   = init_args || {};

    return obj;
}

// Makes a wire that connects the aout to the ain.
// ex: var w3 = wire(sinosc3, 'phase', gain1, 'value');
function wire(block1, outVar, block2, inVar) {
    return  { outBlock:     block1
            , outVar:       outVar
            , aout:         block1 ? block1.aout[outVar] : outVar
            , inBlock:      block2
            , inVar:        inVar
            , ain:          block2 ? block2.ain[inVar] : inVar
            };
}

function flatten(arrarr) {
    return Array.prototype.concat.apply([], arrarr);
}

// blocks = array of stuff returned by block()
// wires = array of stuff returned by wire()
// signals = {} where keys = names of exposed parameters and values = {point: someOp.aout.someVar, ...}
//
// The return value is a function suitable for use as a JavascriptAudioNode's onaudioprocess
// handler. The signals are exposed as properties of this function using the
// given names.
function compile(system, blocks, wires, signals, sampleRate, oversampleFactor) {

    oversampleFactor = oversampleFactor || 1;

    var template = function (Math, system) {
        var _ain = 0, _aout = 0, _ainL = 0, _ainR = 0, _aoutL = 0, _aoutR = 0;
        MEMORY_DECLARATIONS
        Math.TAU = 2 * Math.PI;
        function onaudioprocess(event) {
            DECLARE_LOCAL_MEMORY
            DECLARE_LOCAL_VARIABLES
            DECLARE_INPUT
            var outputL = event.outputBuffer.getChannelData(0);
            var outputR = event.outputBuffer.getChannelData(1);
            var i, j, k, N = event.outputBuffer.length, dt = 1.0 / (OVERSAMPLE_FACTOR * event.outputBuffer.sampleRate);
            var ain = _ain, aout = _aout, ainL = _ainL, ainR = _ainR, aoutL = _aoutL, aoutR = _aoutR; 
            // These are for use by the blocks and wires.
            COPY_INTO_LOCAL_MEMORY
            for (i = 0; i < N; ++i) {
                GET_INPUT
                for (j = 0; j < OVERSAMPLE_FACTOR; ++j) {
                    PROCESS_BLOCKS
                    TRANSMIT_WIRES
                }
                PROCESS_OUTPUTS
                outputL[i] = aoutL + aout;
                outputR[i] = aoutR + aout;
            }
            COPY_OUT_FROM_LOCAL_MEMORY
            _ain = ain;
            _aout = aout;
            _ainL = ainL;
            _ainR = ainR;
            _aoutL = aoutL;
            _aoutR = aoutR;
            system.emit('audioprocess', system);
        }
        SIGNAL_DECLARATIONS
        EXPOSE_MEMORY
        return onaudioprocess;
    };

    function getVars(type) {
        return flatten(blocks.map(function (b) {
            var bs = b.operator.toString();
            return Object.keys(b[type]).map(function (k) {
                return {
                    varname: b[type][k], 
                    vartype: (bs.indexOf(type+'.'+k+'[') >= 0 ? 'array' : 'signal'),
                    signame: b.name + '.' + type + '.' + k
                };
            });
        }));
    }

    function varDeclarator(prefix, init) {
        function varDecl(v) {
            return prefix + v.varname + (init ? ('=' + (v.vartype === 'array' ? '[]' : '0')) : '');
        }
        return varDecl;
    }

    if (!outputUsed(wires)) {
        console.error('WARNING: Nothing connected to the output!');
    }

    function collectLocalVars(prefix, suffix) {
        var vars = {};
        blocks.forEach(function (b) {
            b.locals.forEach(function (l) {
                // No risk in using object as hashtable
                // because all local variables start with 'local_';
                vars[l.renamed] = true;
            });
        });

        vars = Object.keys(vars);
        if (vars.length > 0) {
            return prefix + vars.join(',') + suffix;
        } else {
            return '';
        }
    }

    var OVERSAMPLE_FACTOR   = ''+oversampleFactor;
    var memories            = getVars('mem'), inputs = getVars('ain'), outputs = getVars('aout');
    var vars                = memories.concat(inputs, outputs);
    var MEMORY_DECLARATIONS = 'var ' + vars.map(varDeclarator('_', true)).join(',\n') + ';\n';
    var PROCESS_BLOCKS      = blocks.filter(function (b) { return Object.keys(b.aout).length > 0; }).map(code).join('');
    var PROCESS_OUTPUTS     = blocks.filter(function (b) { return Object.keys(b.aout).length == 0; }).map(code).join('')
    var DECLARE_LOCAL_MEMORY = 'var ' + vars.map(varDeclarator('', false)).join(',\n') + ';\n';
    var DECLARE_LOCAL_VARIABLES = collectLocalVars('var ', ';\n');
    var COPY_INTO_LOCAL_MEMORY = vars.map(function (v) { return v.varname + ' = _' + v.varname + ';\n'; }).join('');
    var COPY_OUT_FROM_LOCAL_MEMORY = vars.map(function (v) { return '_' + v.varname + ' = ' + v.varname + ';\n'; }).join('');
    var DECLARE_INPUT = inputUsed(wires) ? 'var input = event.inputBuffer.getChannelData(0);\n' : '';
    var GET_INPUT = inputUsed(wires) ? 'ain = input[i];\n' : '';
        
    var transmissionDone    = {};
    var TRANSMIT_WIRES      = 
        wires.map(function (w) {
            var summer = ' += ';
            if (!transmissionDone[w.ain]) {
                transmissionDone[w.ain] = true;
                summer = ' = ';
            }
            return w.ain + summer + w.aout + ';\n';
        }).join('');

    var terminalVars = /^(ain|aout)[LR]?$/;
    var SIGNAL_DECLARATIONS = 
        Object.keys(signals).map(function (s) {
            var sigvar = terminalVars.test(s) ? s : signals[s].point;
            var getter = 'onaudioprocess.__defineGetter__(' + JSON.stringify(s) + ', function () { return _' + sigvar + '; });\n';
            var setter = 'onaudioprocess.__defineSetter__(' + JSON.stringify(s) + ', function ($value) { return _' + sigvar + ' = $value; });\n';
            return getter + setter;
        }).join('');

    var EXPOSE_MEMORY =
        vars.map(function (m) {
            // FIXME: This duplication of names can be avoided. Two places are affected -
            // I'd like simple names of the form "<blockname>.(ain|aout|mem).pinname",
            // which is how the test cases deal with it, but the init() functions use the
            // older raw variable names to set fields. At some point, change the init()
            // functions to use the newer exposed naming scheme.
            var signame = JSON.stringify(m.varname);
            var getter = 'onaudioprocess.__defineGetter__(' + signame + ', function () { return _' + m.varname + '; });\n';
            var setter = 'onaudioprocess.__defineSetter__(' + signame + ', function ($value) { return _' + m.varname + ' = $value; });\n';
            var rawVar = getter + setter;

            signame = JSON.stringify(m.signame);
            getter = 'onaudioprocess.__defineGetter__(' + signame + ', function () { return _' + m.varname + '; });\n';
            setter = 'onaudioprocess.__defineSetter__(' + signame + ', function ($value) { return _' + m.varname + ' = $value; });\n';
            return rawVar + getter + setter;
        }).join('');

    var source = template.toString();

    source = replaceAll(source, 'OVERSAMPLE_FACTOR', OVERSAMPLE_FACTOR);
    source = replaceAll(source, 'DECLARE_LOCAL_VARIABLES', DECLARE_LOCAL_VARIABLES);
    source = replaceAll(source, 'DECLARE_INPUT', DECLARE_INPUT);
    source = replaceAll(source, 'MEMORY_DECLARATIONS', MEMORY_DECLARATIONS);
    source = replaceAll(source, 'GET_INPUT', GET_INPUT);
    source = replaceAll(source, 'PROCESS_BLOCKS', PROCESS_BLOCKS);
    source = replaceAll(source, 'TRANSMIT_WIRES', TRANSMIT_WIRES);
    source = replaceAll(source, 'PROCESS_OUTPUTS', PROCESS_OUTPUTS);
    source = replaceAll(source, 'SIGNAL_DECLARATIONS', SIGNAL_DECLARATIONS);
    source = replaceAll(source, 'EXPOSE_MEMORY', EXPOSE_MEMORY);
    source = replaceAll(source, 'DECLARE_LOCAL_MEMORY', DECLARE_LOCAL_MEMORY);
    source = replaceAll(source, 'COPY_INTO_LOCAL_MEMORY', COPY_INTO_LOCAL_MEMORY);
    source = replaceAll(source, 'COPY_OUT_FROM_LOCAL_MEMORY', COPY_OUT_FROM_LOCAL_MEMORY);

    console.log(source);

    var proc = eval('('+source+')')(Math, system);

    proc.sampleRate_Hz = sampleRate * oversampleFactor;
    proc.blockSize = 1024; 

    // Initialize blocks.
    blocks.forEach(function (b) {
        if (b.init) {
            b.init(proc, b.init_args);
        }
    });

    return proc;
}

function inputUsed(wires) {
    var i, N;
    for (i = 0, N = wires.length; i < N; ++i) {
        if (wires[i].aout === 'ain') {
            return true;
        }
    }
    return false;
}

function outputUsed(wires) {
    var i, N;
    for (i = 0, N = wires.length; i < N; ++i) {
        if (wires[i].ain === 'aout') {
            return true;
        }
    }
    return false;
}

// Use transferState() for seamless editing of the graph.
// Whatever objects the graphs share, the states of those
// will be copied over.
function transferState(src, dest) {
    Object.keys(src).forEach(function (srck) {
        if (src.__lookupGetter__(srck) && dest.__lookupSetter__(srck)) {
            dest[srck] = src[srck];
        }
    });
}

// Adds on(eventNames, callback), off(eventNames, [callback]) and emit(eventNames, arg)
// methods to the given object. Events are emitted asynchronously.
// Multiple event names are space-separated.
function EventEmitter(obj) {
    var handlers = {};

    function on(eventName, callback) {
        var hs = handlers[eventName] || (handlers[eventName] = []);
        hs.push(callback);
        return obj;
    }

    var eventNameSeparator = /\s+/g;

    function off(eventNames, callback) {
        var hs, eventNamesArr, i, N, eventName;

        eventNamesArr = eventNames.split(eventNameSeparator);

        for (i = 0, N = eventNamesArr.length; i < N; ++i) {
            eventName = eventNamesArr[i];
            hs = handlers[eventName];
            if (callback) {
                if (hs) {
                    handlers[eventName] = hs.filter(function (c) { return c !== callback; });
                }
            } else {
                // Turn off all callbacks
                delete handlers[eventName];
            }
        }

        return obj;
    }

    function emit(eventNames, arg) {
         var hs, eventNamesArr, i, N, eventName;

        eventNamesArr = eventNames.split(eventNameSeparator);

        for (i = 0, N = eventNamesArr.length; i < N; ++i) {
            eventName = eventNamesArr[i];

            hs = handlers[eventName];
            if (hs && hs.length > 0) {
                setTimeout(emitNow, 0, hs, eventName, arg);
            }
        }

        return obj;
    }

    function emitNow(hs, eventName, arg) {
        var i, N;
        for (i = 0, N = hs.length; i < N; ++i) {
            hs[i](obj, eventName, arg);
        }
    }

    obj.on = on;
    obj.off = off;
    obj.emit = emit;
    return obj;
}


function System(sampleRate, oversampleFactor) {

    sampleRate = sampleRate || 44100;
    oversampleFactor = Math.max(1, Math.min(oversampleFactor || 1, 64));

    var wires = [], namedWires = {};
    var blocks = [], namedBlocks = {};
    var signals = {};

    var self = EventEmitter(this === G ? {} : this); // Don't clobber global namespace.
    var system = null;

    function nb(b) {
        return (typeof b === 'string') ? namedBlocks[b] : b;
    }

    function dirty() {
        if (system) {
            self.emit('dirty');
        }
        system = null;
    }

    self.block = function (name, op, init_args) {
        if (arguments.length === 1) {
            return nb(name);
        }

        var kind = '';
        if (typeof op === 'string') {
            op = package('sriku.wireup.blocks.' + op);
            kind = op;
        }

        var b = EventEmitter(block(op, init_args));
        b.kind = kind;
        b.name = name;
        self.removeBlock(name);
        namedBlocks[name] = b;
        dirty();
        return b;
    };

    function wireName(w) {
        return w.outBlock.name+'.'+w.outVar+'->'+w.inBlock.name+'.'+w.inVar;
    }

    self.wire = function (b1, aout, b2, ain) {
        var w, t1, t2, name;
        if (arguments.length === 2) {
            // name1.pinname, name2.pinname format
            t1 = arguments[0].split('.');
            t2 = arguments[1].split('.');
            w = wire( nb(t1.length > 1 ? t1[0] : null)
                    , (t1.length > 1 ? t1[1] : t1[0])
                    , nb(t2.length > 1 ? t2[0] : null)
                    , (t2.length > 1 ? t2[1] : t2[0]));
        } else if (arguments.length === 4) {
            w = wire(nb(b1), aout, nb(b2), ain);
        } else {
            throw new Error('wire: Argument error');
        }

        var name = wireName(w);
        if (!namedWires[name]) {
            namedWires[name] = EventEmitter(w);
            w.name = name;
            dirty();
            if (w.outBlock) {
                w.outBlock.emit('connected.aout', w);
            }
            if (w.inBlock) {
                w.inBlock.emit('connected.ain', w);
            }
        }
        return w;
    };

    self.removeBlock = function (name) {
        var block = namedBlocks[name];
        if (block) {
            Object.keys(namedWires).forEach(function (n) {
                var w = namedWires[n];
                if (w.outBlock === block || w.inBlock === block) {
                    self.removeWire(n);
                }
            });
            dirty();
            block.emit('die');
        }
        return self;
    };

    self.removeWire = function (name) {
        var w = namedWires[name];
        if (w) {
            delete namedWires[name];
            dirty();
            if (w.outBlock) {
                w.outBlock.emit('disconnected.aout', w);
            }
            if (w.inBlock) {
                w.inBlock.emit('disconnected.ain', w);
            }
            w.emit('die');
        }
        return self;
    };

    self.signal = function (name, pin) {
        signals[name] = pin;
        dirty();
        return self;
    };

    self.__defineGetter__('system', function () {
        if (!system) {
            blocks = Object.keys(namedBlocks).map(function (k) { return namedBlocks[k]; });
            system = compile( self
                            , blocks
                            , Object.keys(namedWires).map(function (n) { return namedWires[n]; })
                            , signals
                            , sampleRate
                            , oversampleFactor
                            );
            self.emit('ready');
        }
        return system;
    });

    return self;
}


return System;

});

package('sriku.wireup.ui', ['Kinetic'], function (Kinetic) {

    var WIRES_LAYER = 'wires_layer';
    var BLOCKS_LAYER = 'blocks_layer';

    var icons = {};

    function kineticOperator(spec) {
        var key;
        for (key in spec) {
            return key;
        }
    }

    function instantiateKineticShape(spec) {
        if (spec.constructor !== Object) {
            return spec; // Already instantiated, perhaps?
        }

        if (spec.Group) {
            var g = new Kinetic.Group();
            spec.Group.forEach(function (s) {
                g.add(instantiateKineticShape(s));
            });
            return g;
        } else {
            var key = kineticOperator(spec);

            return new Kinetic[key](spec[key]);
        }
    }

    var wireUnderConstruction = null;

    function beginWire(evt, stage, system, pin, block, aout) {
        if (wireUnderConstruction) {
            // Remove it.
            stage.get('.'+WIRES_LAYER)[0].remove(wireUnderConstruction.line);
            window.removeEventListener('mousemove', wireUnderConstruction.moveline);
            wireUnderConstruction = null;
            return;
        }

        var wiresLayer = stage.get('.'+WIRES_LAYER)[0];
        if (!wiresLayer) {
            stage.add(new Kinetic.Layer({ name: 'wires_layer' }));
            wiresLayer = stage.get('.'+WIRES_LAYER)[0];
        }
 
        var pos = stage.getMousePosition(evt);

        wireUnderConstruction = {
            outBlock: block,
            aout: aout,
            aoutPin: pin,
            line: new Kinetic.Line({ 
                points: [pin.getAbsolutePosition(), pos],
                stroke: 'black',
                detectonType: 'path'
            }),
            moveline: function (evt) {
                var mouse = stage.getMousePosition(evt);
                wireUnderConstruction.line.setPoints([pin.getAbsolutePosition(), {x: mouse.x, y: mouse.y}]);
                wiresLayer.draw();
            }
        };

        wiresLayer.add(wireUnderConstruction.line);
        wiresLayer.draw();

        window.addEventListener('mousemove', wireUnderConstruction.moveline);
    }

    function endWire(evt, stage, system, pin, block, ain) {

        if (!wireUnderConstruction) {
            return;
        }

        wireUnderConstruction.inBlock = block;
        wireUnderConstruction.ain = ain;
        wireUnderConstruction.ainPin = pin;

        var wire = wireUnderConstruction;

        wire.line.setPoints([
                wireUnderConstruction.aoutPin.getAbsolutePosition(),
                pin.getAbsolutePosition()
                ]);

        var wiresLayer = stage.get('.'+WIRES_LAYER)[0];
        wiresLayer.draw();
        window.removeEventListener('mousemove', wireUnderConstruction.moveline);

        if (evt.shiftKey) {
            system.removeWire(wire.outBlock.name+'.'+wire.aout+'->'+wire.inBlock.name+'.'+wire.ain);
            wiresLayer.remove(wire.line);
            wiresLayer.draw();
            wireUnderConstruction = null;
            return;
        }

        wire.update = function (evt) {
            wire.line.setPoints([wire.aoutPin.getAbsolutePosition(), wire.ainPin.getAbsolutePosition()]);
            wiresLayer.draw();
        };

        wire.die = function () {
            wiresLayer.remove(wire.line);
            wiresLayer.draw();
        };

        var liveWire = system.wire(wire.outBlock, wire.aout, wire.inBlock, wire.ain);

        wire.line.on('click', function (evt) {
            if (evt.shiftKey) {
                system.removeWire(liveWire.name);
            }
        });

        system.emit('add_wire', wire);
        wireUnderConstruction = null;

        wire.outBlock.on('dragmove', wire.update);
        wire.inBlock.on('dragmove', wire.update);
        liveWire.on('die', wire.die);
    }


    function tipLayer(stage) {
        var layer = stage.get('.tip_layer')[0];
        if (!layer) {
            stage.add(new Kinetic.Layer({ name: 'tip_layer' }));
            layer = stage.get('.tip_layer')[0];
        }
        return layer;
    }

    function showTip(pin, stage, tip, dx, dy) {
        var layer = tipLayer(stage);
        function tipH(evt) {
            var context = layer.getContext();
            layer.clear();
            context.font = '12pt';
            context.fillStyle = 'blue';
            context.background = 'black'
            var pos = pin.getAbsolutePosition();
            context.fillText(tip, pos.x + dx, pos.y + dy);
        }
        pin.on('mouseover', tipH);
        pin.on('mouseout mousedown', function (evt) {
            layer.clear();
        });
    }

    this.makeShape = function (stage, system, block) {
        if (!block.ui) {
            return undefined;
        }

        var tips = tipLayer(stage);

        var group = new Kinetic.Group({ draggable: true, name: block.name });
        var shape = instantiateKineticShape(block.ui.shape);
        var pinLineWidth = 15;

        group.add(shape);
        
        Object.keys(block.ui.inputs).forEach(function (k) {
            var spec = block.ui.inputs[k];
            group.add(new Kinetic.Line({
                points: [{x: spec.x - pinLineWidth, y: spec.y}, {x: spec.x, y: spec.y}],
                stroke: 'black'
            }));
            var pin = new Kinetic.Circle({
                x: spec.x - pinLineWidth,
                y: spec.y,
                radius: 5,
                fill: 'black'
            });
            pin.on('click', function (evt) { endWire(evt, stage, system, pin, block, k); });
            showTip(pin, stage, spec.tip || k, spec.tipx || -40, spec.tipy || 0);
            group.add(pin);
        });
        
        Object.keys(block.ui.outputs).forEach(function (k) {
            var spec = block.ui.outputs[k];
            group.add(new Kinetic.Line({
                points: [{x: spec.x, y: spec.y}, {x: spec.x + pinLineWidth, y: spec.y}],
                stroke: 'black'
            }));
            var pin = new Kinetic.Circle({
                x: spec.x + pinLineWidth,
                y: spec.y,
                radius: 5,
                fill: 'black'
            });
            pin.on('click', function (evt) { beginWire(evt, stage, system, pin, block, k); });
            showTip(pin, stage, spec.tip || k, spec.tipx || 10, spec.tipy || 0);
            group.add(pin);
        });

        group.wireup = {block: block};
        group.on('dragmove', function (evt) {
            block.emit('dragmove', evt);
        });
        showTip(shape, stage, block.ui.tip || block.kind.name, block.ui.tipx || 0, block.ui.tipy || -30);

        if (block.onaudioprocess) {
            var oap = block.onaudioprocess;
            block.shape = shape;
            block.onaudioprocess = function (system) {
                oap.call(block, system);
            };
            system.on('audioprocess', block.onaudioprocess);
        }

        return group;
    };

    this.icon = function (stage, kind) {
        return icons[kind] || (icons[kind] = (function () {

            var block = package('sriku.wireup.blocks.*')[kind];

            if (!block.prototype.ui) {
                return undefined;
            }

            if (block.prototype.ui.icon) {
                return block.prototype.ui.icon;
            }

            var icon;
            if (block.prototype.ui.icon) {
                icon = instantiateKineticShape(block.prototype.ui.icon);
            } else {
                icon = instantiateKineticShape(block.prototype.ui.shape);
                icon.setScale(0.66);
            }

            return icon;
        }()));
    };

    this.WIRES_LAYER = WIRES_LAYER;
    this.BLOCKS_LAYER = BLOCKS_LAYER;
});

package('sriku.wireup.blocks.aout', function () {
    function aout(dt, ain, aout, mem) {
        aoutL = ain.left;
        aoutR = ain.right;
        aout = ain.centre;
    }

    aout.prototype.ui = {
        shape: {Polygon: {
            points: [{x: 0, y: 0}, {x: 0, y: 60}, {x: 5, y: 60}, {x: 5, y: 0}],
            stroke: 'black',
            fill: 'black'
        }},
        inputs: {
            left: {x: 0, y: 15, tipx: -22},
            centre: {x: 0, y: 30, tipx: -40},
            right: {x: 0, y: 45, tipx: -30}
        },
        outputs: {},
        tipx: -10,
        tipy: -5
    };

    return aout;
});

package('sriku.wireup.blocks.probe', function () {
    function probe(dt, ain, aout, mem) {
        mem.record[i] = ain.value;
    }

    probe.prototype.init = function (system, arg) {
        system[this.mem.record] = new Float64Array(system.blockSize);
    };

    probe.prototype.ui = {
        inputs: {value: {x: 0, y: 64, tipx: -40}},
        outputs: {},
        shape: {Group: [
            {Polygon: {
                points: [0, 0, 0, 128, 256, 128, 256, 0],
                stroke: 'black',
                fill: 'white'
            }},
            {Shape: {
                drawFunc: (function () {
                    var ctxt = this.getContext();
                    var probe = this.probe;
                    if (probe) {
                        var i, N;
                        ctxt.beginPath();
                        ctxt.moveTo(0, 64 - probe[0] * 60);
                        for (i = 1, N = probe.length; i < N; ++i) {
                            ctxt.lineTo(i * 250 / N, 64 - Math.min(1, Math.max(-1, probe[i])) * 60);
                        }
                        ctxt.stroke();
                    }
                }),
                stroke: 'black',
                strokeWidth: 0.5
            }}
        ]},
        tipx: 0,
        tipy: -5
    };

    probe.prototype.onaudioprocess = function (S) {
        var thisTime_ms = Date.now();
        if (!this.lastTime_ms || thisTime_ms - this.lastTime_ms > 100) {
            var probe = S.system[this.mem.record];
            this.shape.getChildren()[1].probe = probe;
            this.shape.draw();
            this.lastTime_ms = thisTime_ms;
        }
    };

    return probe;
});

package('sriku.wireup.blocks.delay', function () {
    function delay(dt, ain, aout, mem) {
        aout.value = ain.value;
    }

    delay.prototype.ui = {
        shape: {Polygon: {
            points: [{x: 0, y: 0}, {x: 0, y: 30}, {x: 35, y: 15}],
            stroke: 'black',
            fill: 'white'
        }},
        inputs: {
            value: {x: 0, y: 15, tipx: -40}
        },
        outputs: {
            value: {x: 35, y: 15}
        },
        tipx: 0,
        tipy: -5
    };

    return delay;
});


package('sriku.wireup.blocks.ramp', function () {
    function ramp(dt, ain, aout, mem) {
        mem.value += ain.rate * dt;
        aout.value = mem.value;
    }

    ramp.prototype.ui = {
        inputs: {rate: {x: 0, y: 25, tipx: 0, tipy: -10}},
        outputs: {value: {x: 50, y: 25}},
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    
    return ramp;
});

package('sriku.wireup.blocks.phasor', function () {
    function phasor(dt, ain, aout, mem) {
        mem.value = (mem.value + (ain.frequency + mem.frequency) * dt) % 1;
        aout.phase = mem.value;
    }

    phasor.prototype.init = function (system, args) {
        system[this.mem.frequency] = 'frequency' in args ? args.frequency : 440.0;
    };

    phasor.prototype.ui = {
        shape: {Circle: {radius: 15, x: 0, y: 0, stroke: 'black', fill: 'white'}},
        inputs: {
            frequency: {x: -15, y: 0, tipx: -60, tipy: 0}
        },
        outputs: {
            phase: {x: 15, y: 0}
        },
        tipx: -15,
        tipy: -20
    };

    return phasor;
});

package('sriku.wireup.blocks.sinosc', function () {
    function sinosc(dt, ain, aout, mem) {
        aout.value = Math.sin(Math.TAU * ain.phase);
    }

    sinosc.prototype.ui = {
        inputs: {phase: {x: 0, y: 25, tipx: 0, tipy: -10}},
        outputs: {value: {x: 50, y: 25}},
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return sinosc;
});

package('sriku.wireup.blocks.cososc', function () {
    function cososc(dt, ain, aout, mem) {
        aout.value = Math.cos(Math.TAU * ain.phase);
    }

    cososc.prototype.ui = {
        inputs: {phase: {x: 0, y: 25, tipx: 0, tipy: -10}},
        outputs: {value: {x: 50, y: 25}},
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return cososc;
});

package('sriku.wireup.blocks.qosc', function () {
    function qosc(dt, ain, aout, mem) {
        aout.sin = ain.gain * Math.sin(Math.TAU * ain.phase);
        aout.cos = ain.gain * Math.cos(Math.TAU * ain.phase);
    }

    qosc.prototype.init = function (system, arg) {
        system[this.ain.gain] = 'gain' in arg ? arg.gain : 0.5;
    };

    qosc.prototype.ui = {
        shape: {Group: [
            {Circle: {radius: 15, x: 0, y: 0, stroke: 'black', fill: 'white'}},
            {Circle: {radius: 10, x: 0, y: 0, stroke: 'black',fill: 'white'}}
        ]},
        inputs: {
            phase: {x: -10, y: -10, tipx: -40},
            gain: {x: -10, y: 10, tipx: -30}
        },
        outputs: {
            sin: {x: 10, y: -10},
            cos: {x: 10, y: 10}
        },
        tipx: -10,
        tipy: -20
    };

    return qosc;
});

package('sriku.wireup.blocks.sqosc', function () {
    function sqosc(dt, ain, aout, mem) {
        aout.value = (ain.phase < 0.5 ? -1 : (ain.phase > 0.5 ? 1 : 0));
    }

    sqosc.prototype.ui = {
        inputs: {phase: {x: 0, y: 25, tipx: 0, tipy: -10}},
        outputs: {value: {x: 50, y: 25}},
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return sqosc;
});

package('sriku.wireup.blocks.dc', function () {
    function dc(dt, ain, aout, mem) {
        aout.value = ain.value + ain.dc;
    }

    dc.prototype.ui = {
        inputs: {
            value: {x: 0, y: 10, tipx: -30, tipy: 0},
            dc: {x: 0, y: 30, tipx: 15, tipy: 0}
        },
        outputs: {value: {x: 50, y: 25}},
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return dc;
});

package('sriku.wireup.blocks.gain', function () {
    function gain(dt, ain, aout, mem) {
        aout.value = ain.value * ain.gain;
    }

    gain.prototype.init = function (system, args) {
        system[this.ain.gain] = 'gain' in args ? args.gain : 0.25;
    };

    gain.prototype.ui = {
        shape: {Group: [
            {Circle: {x: 0, y: 0, radius: 15, stroke: 'black', fill: 'white'}},
            {Line: {points: [-10, -10, 10, 10], stroke: 'black'}},
            {Line: {points: [-10, 10, 10, -10], stroke: 'black'}}
        ]},
        inputs: {
            value: {x: -10, y: -10, tipx: -40},
            gain: {x: -10, y: 10, tipx: -30}
        },
        outputs: {
            value: {x: 15, y: 0}
        }
    };

    return gain;
});

package('sriku.wireup.blocks.panner', function () {
    // ain.pan in range [-1,1] with -1 corresponding to left
    // and 1 corresponding to right. Default value 0 = mid pan.
    function panner(dt, ain, aout, mem) {
        aout.left = 0.5 * ain.value * (1 - ain.pan);
        aout.right = ain.value - aout.left;
    }

    panner.prototype.init = function (system, args) {
        system[this.ain.pan] = 'pan' in args ? args.pan : 0.0;
    };

    panner.prototype.ui = {
        shape: {Group: [
            {Circle: {x: 0, y: 0, radius: 15, stroke: 'black', fill: 'white'}},
            {Line: {points: [-10, -10, 10, 10], stroke: 'black'}},
            {Line: {points: [-10, 10, 10, -10], stroke: 'black'}}
        ]},
        inputs: {
            value: {x: -10, y: -10, tipx: -40},
            pan: {x: -10, y: 10, tipx: -30}
        },
        outputs: {
            left: {x: 10, y: -10},
            right: {x: 10, y: 10}
        }
    };

    
    return panner;
});

package('sriku.wireup.blocks.lookup', function () {
    // Lookup a table using ain.phase. The phase is normalized
    // in range [0,1] which maps to [0,length-1) of the table.
    // The last sample of the table is supposed to duplicate the
    // first sample for the sake of efficiency.
    function lookup(dt, ain, aout, mem) {
        var ix, ixf, ixl, v1, v2;
        ix = ain.phase * mem.length;
        ixf = ix % 1;
        ixl = ix - ixf;
        v1 = mem.buffer[ixl];
        v2 = mem.buffer[ixl + 1];
        aout.value = v1 + ixf * (v2 - v1);
    }

    lookup.prototype.init = function (system, args) {
        system[this.mem.buffer] = args.buffer;
        system[this.mem.length] = args.buffer.length - 1;
    };

    lookup.prototype.ui = {
        inputs: {
            phase: {x: 0, y: 10, tipx: -40, tipy: 0}
        },
        outputs: {value: {x: 50, y: 25}},
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return lookup;
});

package('sriku.wireup.blocks.hardlimiter', function () {
    function hardlimiter(dt, ain, aout, mem) {
        aout.value = Math.max(mem.low, Math.min(ain.value, mem.high));
    }

    hardlimiter.prototype.init = function (system, args) {
        system[this.mem.low] = 'low' in args ? args.low : -1.0;
        system[this.mem.high] = 'high' in args ? args.high : 1.0;
    };

    hardlimiter.prototype.ui = {
        inputs: {
            value: {x: 0, y: 10, tipx: -40, tipy: 0}
        },
        outputs: {value: {x: 50, y: 25}},
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };
    
    return hardlimiter;
});

package('sriku.wireup.blocks.vardelay', function () {
    // ain.tap controls the tap point [0,1]
    // mem.delay sets the delay value (in samples)
    // ain.inject gets injected into the delay line at the tap.
    // aout.tap is the tap result
    // aout.value is the value at the end of the delay line.
    function vardelay(dt, ain, aout, mem) {
        var i1, i2, tapPoint, frac;
        mem.line[mem.line_end] = ain.value;
        tapPoint = (mem.line_end + mem.delay * (1 - ain.tap)) % mem.delay;
        frac = tapPoint % 1;

        // Linear interpolate intermediate delay values.
        i1 = tapPoint - frac;
        i2 = (tapPoint - frac + 1) % mem.delay;
        aout.tap = mem.line[i1];
        aout.tap += frac * (mem.line[i2] - aout.value);

        mem.line_end = (mem.line_end + 1) % mem.delay;
        aout.value = mem.line[mem.line_end];
        // mem.line[i1] += ain.inject * (1 - frac);
        // mem.line[i2] += ain.inject * frac;
    }

    vardelay.prototype.init = function (system, args) {
        var delay = Math.floor(('delay' in args ? args.delay : 0.1) * system.sampleRate_Hz);
        var tap = args.tap || 1;
        system[this.mem.delay] = delay;
        system[this.mem.line] = new Float32Array(delay);
        system[this.mem.line_end] = 0;
        system[this.ain.tap] = tap;
    };

    vardelay.prototype.ui = {
        inputs: {
            value: {x: 0, y: 10, tipx: -40, tipy: 0},
            tap: {x: 0, y: 30, tipx: -30, tipy: 0}
        },
        outputs: {
            value: {x: 50, y: 10},
            tap: {x: 50, y: 30}
        },
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return vardelay;
});

package('sriku.wireup.blocks.noise', function () {
    function noise(dt, ain, aout, mem) {
        aout.value = 2 * ain.gain * (Math.random() - 0.5)
    }

    noise.prototype.init = function (system, args) {
        system[this.ain.gain] = 'gain' in args ? args.gain : 0.25;
    };

    noise.prototype.ui = {
        inputs: {
            gain: {x: 0, y: 10, tipx: -40, tipy: 0}
        },
        outputs: {
            value: {x: 50, y: 10}
        },
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };
    
    return noise;
});

package('sriku.wireup.blocks.dezipper', function () {
    function dezipper(dt, ain, aout, mem) {
        aout.value = (mem.value += 0.05 * (ain.value - mem.value));
    }

    dezipper.prototype.ui = {
        inputs: {
            value: {x: 0, y: 25, tipx: -40, tipy: 0}
        },
        outputs: {
            value: {x: 50, y: 25}
        },
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };
    
    return dezipper;
});

package('sriku.wireup.blocks.followenv', function () {
    // Simple envelope follower.
    function followenv(dt, ain, aout, mem) {
        if (ain.value < mem.env) {
            mem.env *= mem.decayFactor;
        } else {
            mem.env = ain.value;
        }

        aout.env = mem.env;
    }

    followenv.prototype.init = function (system, args) {
        system[this.mem.decayFactor] = 'decayFactor' in args ? args.decayFactor : 0.99;
        system[this.mem.env] = 0.0;
    };

    followenv.prototype.ui = {
        inputs: {
            value: {x: 0, y: 25, tipx: -40, tipy: 0}
        },
        outputs: {
            env: {x: 50, y: 25}
        },
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return followenv;
});

package('sriku.wireup.blocks.sampler', function () {

    function sampler(dt, ain, aout, mem) {
        var i, j;

        if (ain.trigger - mem.last_trigger > mem.threshold) {
            // Up edge. Trigger a new sound.
            if (mem.end_active - mem.first_active >= mem.maxVoices) {
                ++mem.first_active; // Steal a voice.
            }

            mem.instOffset[(mem.end_active++) % mem.maxVoices] = mem.offset;
        }

        // Mix all running sounds.
        aout.value = 0;
        for (i = mem.first_active; i < mem.end_active; ++i) {
            j = i % mem.maxVoices;
            aout.value += mem.buffer[mem.instOffset[j]++];
            if (mem.instOffset[j] >= mem.buffer.length && i === mem.first_active) {
                ++mem.first_active; // Voice died.
            }
        }

        mem.last_trigger = ain.trigger;
    }

    sampler.prototype.init = function (system, args) {
        var maxVoices = 'maxVoices' in args ? args.maxVoices : 16;
        system[this.mem.buffer] = args.buffer;
        system[this.mem.threshold] = 'threshold' in args ? args.threshold : 0.5;
        system[this.mem.offset] = 0;
        system[this.mem.active] = false;
        system[this.mem.maxVoices] = maxVoices;
        system[this.mem.instOffset] = (new Array(maxVoices)).map(function () { return 0; });
    };

    sampler.prototype.trigger = function (system, offset) {
        system[this.mem.offset] = offset || 0;
        system[this.ain.trigger] = 1;    
    };

    sampler.prototype.ui = {
        inputs: {
            trigger: {x: 0, y: 25, tipx: -50, tipy: 0}
        },
        outputs: {
            value: {x: 50, y: 25}
        },
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return sampler;
});

package('sriku.wireup.blocks.biquad', function () {
    function biquad(dt, ain, aout, mem) {
        aout.value = mem.b0 * ain.value + mem.b1 * mem.in1 + mem.b2 * mem.in2 - (mem.a1 * mem.out1 + mem.a2 * mem.out2);
        mem.in2 = mem.in1;
        mem.in1 = ain.value;
        mem.out2 = mem.out1;
        mem.out1 = aout.value;
    }

    // Ex: 
    // S.block('biquad', {lowpass: {cutoff: 100, resonance: 0.1}});
    // S.block('biquad', {highpass: {cutoff: 100, resonance: 0.1}});
    // S.block('biquad', {bandpass: {frequency: 100, Q: 5}});
    // S.block('biquad', {lowshelf: {frequency: 100, dbGain: 3}});
    // S.block('biquad', {highshelf: {frequency: 100, dbGain: 3}});
    // S.block('biquad', {peaking: {frequency: 100, Q: 5, dbGain: 3}});
    // S.block('biquad', {notch: {frequency: 100, Q: 5}});
    // S.block('biquad', {allpass: {frequency: 100, Q: 5}});
    biquad.prototype.init = function (system, args) {
        var kind;
        for (kind in args) {
            break;
        }

        if (kind in this) {
            this[kind](system, args[kind]);
        } else {
            this.set(system, 1, 0, 0, 1, 0, 0);
            throw new Error('biquad: No such kind of biquad filter - ' + kind);
        }
    };

    biquad.prototype.ui = {
        inputs: {
            value: {x: 0, y: 25, tipx: -40, tipy: 0}
        },
        outputs: {
            value: {x: 50, y: 25}
        },
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };
    
    biquad.prototype.set = function (system, b0, b1, b2, a0, a1, a2) {
        var a0inv = 1.0 / a0;

        system[this.mem.b0] = b0 * a0inv;
        system[this.mem.b1] = b1 * a0inv;
        system[this.mem.b2] = b2 * a0inv;
        system[this.mem.a1] = a1 * a0inv;
        system[this.mem.a2] = a2 * a0inv;
    };
    
    biquad.prototype.generic = function (system, args) {
        var a0inv = 1.0 / args.a0;

        system[this.mem.b0] = args.b0 * a0inv;
        system[this.mem.b1] = args.b1 * a0inv;
        system[this.mem.b2] = args.b2 * a0inv;
        system[this.mem.a1] = args.a1 * a0inv;
        system[this.mem.a2] = args.a2 * a0inv;
    };

    /**
     * Filter coefficient setting code ported from Biquad.cpp in the Web audio API
     * implementation in WebKit. The license terms are reproduced below as required.
     * The copyright and terms apply to the eight functions below named -
     *      lowpass, highpass, bandpass, allpass, lowshelf, highshelf, 
     *      peaking and notch.
     *
     * Copyright (C) 2010 Google Inc. All rights reserved.
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions
     * are met:
     *
     * 1.  Redistributions of source code must retain the above copyright
     *     notice, this list of conditions and the following disclaimer.
     * 2.  Redistributions in binary form must reproduce the above copyright
     *     notice, this list of conditions and the following disclaimer in the
     *     documentation and/or other materials provided with the distribution.
     * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
     *     its contributors may be used to endorse or promote products derived
     *     from this software without specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
     * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
     * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
     * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
     * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
     * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
     * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
     * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     * 
     */
    biquad.prototype.lowpass = function (system, args) {
        var cutoff = args.cutoff;
        var resonance = args.resonance;
        cutoff /= system.sampleRate_Hz;

        // Limit cutoff to 0 to 1.
        cutoff = Math.max(0, Math.min(cutoff, 1));

        if (cutoff === 1) {
            // When cutoff is 1, the z-transform is 1.
            this.set(system, 1, 0, 0, 1, 0, 0);
        } else if (cutoff > 0) {
            // Compute biquad coefficients for lowpass filter
            resonance = Math.max(0, resonance); // can't go negative

            var g = Math.pow(10, 0.05 * resonance);
            var d = Math.sqrt((4 - Math.sqrt(16 - 16 / (g * g))) / 2);

            var theta = Math.PI * cutoff;
            var sn = 0.5 * d * Math.sin(theta);
            var beta = 0.5 * (1 - sn) / (1 + sn);
            var gamma = (0.5 + beta) * cos(theta);
            var alpha = 0.25 * (0.5 + beta - gamma);

            var b0 = 2 * alpha;
            var b1 = 2 * b0;
            var b2 = b1;
            var a1 = 2 * -gamma;
            var a2 = 2 * beta;

            this.set(system, b0, b1, b2, 1, a1, a2);
        } else {
            // When cutoff is zero, nothing gets through the filter, so set
            // coefficients up correctly.
            this.set(0, 0, 0, 1, 0, 0);
        }
    };

    biquad.prototype.highpass = function (system, args) {
        var cutoff = args.cutoff;
        var resonance = args.resonance;
        cutoff /= system.sampleRate_Hz;

        // Limit cutoff to 0 to 1.
        cutoff = Math.max(0, Math.min(cutoff, 1));

        if (cutoff === 1) {
            // The z-transform is 0.
            this.set(system, 0, 0, 0, 1, 0, 0);
        } else if (cutoff > 0) {
            // Compute biquad coefficients for lowpass filter
            resonance = Math.max(0, resonance); // can't go negative

            var g = Math.pow(10, 0.05 * resonance);
            var d = Math.sqrt((4 - Math.sqrt(16 - 16 / (g * g))) / 2);

            var theta = Math.PI * cutoff;
            var sn = 0.5 * d * Math.sin(theta);
            var beta = 0.5 * (1 - sn) / (1 + sn);
            var gamma = (0.5 + beta) * cos(theta);
            var alpha = 0.25 * (0.5 + beta - gamma);

            var b0 = 2 * alpha;
            var b1 = 2 * -b0;
            var b2 = b1;
            var a1 = 2 * -gamma;
            var a2 = 2 * beta;

            this.set(system, b0, b1, b2, 1, a1, a2);
        } else {
            // When cutoff is zero, we need to be careful because the above
            // gives a quadratic divided by the same quadratic, with poles
            // and zeros on the unit circle in the same place. When cutoff
            // is zero, the z-transform is 1.
            this.set(1, 0, 0, 1, 0, 0);
        }
    };

    biquad.prototype.lowshelf = function (system, args) {
        var frequency = args.frequency;
        var dbGain = args.dbGain;
        frequency /= system.sampleRate_Hz;

        // Clip frequencies to between 0 and 1, inclusive.
        frequency = Math.max(0, Math.min(frequency, 1));

        var A = Math.pow(10.0, dbGain / 40);

        if (frequency == 1) {
            // The z-transform is a constant gain.
            this.set(system, A * A, 0, 0, 1, 0, 0);
        } else if (frequency > 0) {
            var w0 = Math.PI * frequency;
            var S = 1; // filter slope (1 is max value)
            var alpha = 0.5 * Math.sin(w0) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
            var k = Math.cos(w0);
            var k2 = 2 * Math.sqrt(A) * alpha;
            var aPlusOne = A + 1;
            var aMinusOne = A - 1;

            var b0 = A * (aPlusOne - aMinusOne * k + k2);
            var b1 = 2 * A * (aMinusOne - aPlusOne * k);
            var b2 = A * (aPlusOne - aMinusOne * k - k2);
            var a0 = aPlusOne + aMinusOne * k + k2;
            var a1 = -2 * (aMinusOne + aPlusOne * k);
            var a2 = aPlusOne + aMinusOne * k - k2;

            this.set(system, b0, b1, b2, a0, a1, a2);
        } else {
            // When frequency is 0, the z-transform is 1.
            this.set(system, 1, 0, 0, 1, 0, 0);
        }
    };

    biquad.prototype.highshelf = function (system, args) {
        var frequency = args.frequency;
        var dbGain = args.dbGain;
        frequency /= system.sampleRate_Hz;

        // Clip frequencies to between 0 and 1, inclusive.
        frequency = Math.max(0.0, Math.min(frequency, 1.0));

        var A = Math.pow(10.0, dbGain / 40);

        if (frequency == 1) {
            // The z-transform is 1.
            this.set(system, 1, 0, 0, 1, 0, 0);
        } else if (frequency > 0) {
            var w0 = Math.PI * frequency;
            var S = 1; // filter slope (1 is max value)
            var alpha = 0.5 * Math.sin(w0) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
            var k = Math.cos(w0);
            var k2 = 2 * Math.sqrt(A) * alpha;
            var aPlusOne = A + 1;
            var aMinusOne = A - 1;

            var b0 = A * (aPlusOne + aMinusOne * k + k2);
            var b1 = -2 * A * (aMinusOne + aPlusOne * k);
            var b2 = A * (aPlusOne + aMinusOne * k - k2);
            var a0 = aPlusOne - aMinusOne * k + k2;
            var a1 = 2 * (aMinusOne - aPlusOne * k);
            var a2 = aPlusOne - aMinusOne * k - k2;

            this.set(system, b0, b1, b2, a0, a1, a2);
        } else {
            // When frequency = 0, the filter is just a gain, A^2.
            this.set(system, A * A, 0, 0, 1, 0, 0);
        }
    };

    biquad.prototype.peaking = function (system, args) {
        var frequency = args.frequency;
        var Q = args.Q;
        var dbGain = args.dbGain;
        frequency /= system.sampleRate_Hz;

        // Clip frequencies to between 0 and 1, inclusive.
        frequency = Math.max(0.0, Math.min(frequency, 1.0));

        // Don't let Q go negative, which causes an unstable filter.
        Q = Math.max(0.0, Q);

        var A = Math.pow(10.0, dbGain / 40);

        if (frequency > 0 && frequency < 1) {
            if (Q > 0) {
                var w0 = Math.PI * frequency;
                var alpha = Math.sin(w0) / (2 * Q);
                var k = Math.cos(w0);

                var b0 = 1 + alpha * A;
                var b1 = -2 * k;
                var b2 = 1 - alpha * A;
                var a0 = 1 + alpha / A;
                var a1 = -2 * k;
                var a2 = 1 - alpha / A;

                this.set(system, b0, b1, b2, a0, a1, a2);
            } else {
                // When Q = 0, the above formulas have problems. If we look at
                // the z-transform, we can see that the limit as Q->0 is A^2, so
                // set the filter that way.
                this.set(system, A * A, 0, 0, 1, 0, 0);
            }
        } else {
            // When frequency is 0 or 1, the z-transform is 1.
            this.set(system, 1, 0, 0, 1, 0, 0);
        }
    };

    biquad.prototype.allpass = function (system, args) {
        var frequency = args.frequency;
        var Q = args.Q;
        frequency /= system.sampleRate_Hz;

        // Clip frequencies to between 0 and 1, inclusive.
        frequency = Math.max(0.0, Math.min(frequency, 1.0));

        // Don't let Q go negative, which causes an unstable filter.
        Q = Math.max(0.0, Q);

        if (frequency > 0 && frequency < 1) {
            if (Q > 0) {
                var w0 = Math.PI * frequency;
                var alpha = Math.sin(w0) / (2 * Q);
                var k = Math.cos(w0);

                var b0 = 1 - alpha;
                var b1 = -2 * k;
                var b2 = 1 + alpha;
                var a0 = 1 + alpha;
                var a1 = -2 * k;
                var a2 = 1 - alpha;

                this.set(system, b0, b1, b2, a0, a1, a2);
            } else {
                // When Q = 0, the above formulas have problems. If we look at
                // the z-transform, we can see that the limit as Q->0 is -1, so
                // set the filter that way.
                this.set(system, -1, 0, 0, 1, 0, 0);
            }
        } else {
            // When frequency is 0 or 1, the z-transform is 1.
            this.set(system, 1, 0, 0, 1, 0, 0);
        }
    };

    biquad.prototype.notch = function (system, args) {
        var frequency = args.frequency;
        var Q = args.Q;
        frequency /= system.sampleRate_Hz;

        // Clip frequencies to between 0 and 1, inclusive.
        frequency = Math.max(0.0, Math.min(frequency, 1.0));

        // Don't let Q go negative, which causes an unstable filter.
        Q = Math.max(0.0, Q);

        if (frequency > 0 && frequency < 1) {
            if (Q > 0) {
                var w0 = Math.PI * frequency;
                var alpha = Math.sin(w0) / (2 * Q);
                var k = Math.cos(w0);

                var b0 = 1;
                var b1 = -2 * k;
                var b2 = 1;
                var a0 = 1 + alpha;
                var a1 = -2 * k;
                var a2 = 1 - alpha;

                this.set(system, b0, b1, b2, a0, a1, a2);
            } else {
                // When Q = 0, the above formulas have problems. If we look at
                // the z-transform, we can see that the limit as Q->0 is 0, so
                // set the filter that way.
                this.set(system, 0, 0, 0, 1, 0, 0);
            }
        } else {
            // When frequency is 0 or 1, the z-transform is 1.
            this.set(system, 1, 0, 0, 1, 0, 0);
        }
    };

    biquad.prototype.bandpass = function (system, args) {
        var frequency = args.frequency;
        var Q = args.Q;
        frequency /= system.sampleRate_Hz;

        // No negative frequencies allowed.
        frequency = Math.max(0.0, frequency);

        // Don't let Q go negative, which causes an unstable filter.
        Q = Math.max(0.0, Q);

        if (frequency > 0 && frequency < 1) {
            var w0 = Math.PI * frequency;
            if (Q > 0) {
                var alpha = Math.sin(w0) / (2 * Q);
                var k = Math.cos(w0);

                var b0 = alpha;
                var b1 = 0;
                var b2 = -alpha;
                var a0 = 1 + alpha;
                var a1 = -2 * k;
                var a2 = 1 - alpha;

                this.set(system, b0, b1, b2, a0, a1, a2);
            } else {
                // When Q = 0, the above formulas have problems. If we look at
                // the z-transform, we can see that the limit as Q->0 is 1, so
                // set the filter that way.
                this.set(system, 1, 0, 0, 1, 0, 0);
            }
        } else {
            // When the cutoff is zero, the z-transform approaches 0, if Q
            // > 0. When both Q and cutoff are zero, the z-transform is
            // pretty much undefined. What should we do in this case?
            // For now, just make the filter 0. When the cutoff is 1, the
            // z-transform also approaches 0.
            this.set(system, 0, 0, 0, 1, 0, 0);
        }
    };

    return biquad;
});

package('sriku.wireup.blocks.wavetable', function () {

    // Simple wavetable oscillator based on given fourier series.
    // ain.frequency is a live control of frequency in Hz
    // aout.cos and aout.sin are the output components.
    //
    // Note: aout.sin is commented out at the moment 'cos it may 
    // not be needed in most cases and would be wasted computation.
    function wavetable(dt, ain, aout, mem) {
        var i, dw, dp, p1, p2, pend, c;

        dw = Math.TAU / 360;
        dp = 360 * ain.frequency * dt;

        // DC value
        aout.cos = Math.cos(mem.phase[0]) * mem.magn[0];
        // aout.sin = Math.sin(mem.phase[0]) * mem.magn[0];

        // Frequency components.
        for (i = 1; i < mem.N; ++i) {
            p1 = mem.runningPhase[i] + mem.phase[i];
            p2 = p1 + i * dp;
            pend = p2 - 1;
            for (c = 0; p1 <= pend; p1 += 1) {
                c += Math.cos(dw * p1);
            }
            c += (p2 - p1) * Math.cos(dw * p2);
            c /= i * dp;
            aout.cos += c;

            mem.runningPhase[i] = p2 % 360;
        }
    }

    // args.magn and args.phase or args.real and args.imag
    // args.frequency in Hz (default 440)
    wavetable.prototype.init = function (system, args) {
        var magn, phase, i;
        if (args.magn) {
            system[this.mem.N] = args.magn.length;
            system[this.mem.magn] = magn = args.magn;
            if (args.phase) {
                system[this.mem.phase] = phase = args.phase;
            } else {
                system[this.mem.phase] = phase = new Float32Array(args.magn.length);
            }
        } else if (args.real) {
            system[this.mem.N] = args.real.length;
            magn = new Float32Array(args.real.length);
            phase = new Float32Array(args.real.length);
            for (i = 0; i < args.real.length; ++i) {
                magn[i] = Math.sqrt(args.real[i] * args.real[i] + (args.imag ? args.imag[i] * args.imag[i] : 0));
                phase[i] = 360 * Math.atan2(args.imag ? args.imag[i] : 0, args.real[i]) / Math.TAU;
            }
            system[this.mem.magn] = magn;
            system[this.mem.phase] = phase;
        } else {
            magn = new Float32Array(2);
            phase = new Float32Array(2);
            magn[0] = 0;
            magn[1] = 1;
            system[this.mem.N] = magn.length;
            system[this.mem.magn] = magn;
            system[this.mem.phase] = phase;
        }

        system[this.ain.frequency] = args.frequency || 440;
        system[this.mem.runningPhase] = new Float32Array(phase.length);
    };

    wavetable.prototype.ui = {
        inputs: {
            frequency: {x: 0, y: 25, tipx: -50, tipy: 0}
        },
        outputs: {
            cos: {x: 50, y: 25}
        },
        shape: {Polygon: {
            points: [0, 0, 0, 50, 50, 50, 50, 0],
            stroke: 'black',
            fill: 'white'
        }},
        tipx: 0,
        tipy: -5
    };

    return wavetable;
});

package('sriku.wireup.tests', ['.system', '.ui'], function (System, UI) {
    function system(S) {
        var start = Date.now();
        var sys = S.system;
        var stop = Date.now();
        console.log('Time taken = ' + Math.round(stop - start));
        return sys;
    }

    function test1() {
        var S = new System();
        S.block('phasor1', 'phasor');
        S.block('sinosc1', 'sinosc');
        S.wire('phasor1.phase', 'sinosc1.phase');
        S.wire('sinosc1', 'value', 'aout');
        return system(S);
    }

    function test2() {
        var S = new System();
        S.block('phasor1', 'phasor');
        S.block('sinosc1', 'sinosc');
        S.block('gain1', 'gain');
        S.wire('phasor1.phase', 'sinosc1.phase');
        S.wire('sinosc1.value', 'gain1.value');
        S.wire('gain1.value', 'aout');
        return system(S);
    }

    function junktest(f) {
        var S = new System();
        S.block('konst', 'delay');
        S.block('modulator', 'phasor', {frequency: 100});
        S.block('modsine', 'sinosc');
        S.block('amplitude', 'gain', {gain: 20});
        S.block('phasor1', 'phasor', {frequency: f || 440.0});
        S.block('sinosc1', 'sinosc');
        S.block('vol1', 'gain', {gain: 0.2});
        S.block('delay1', 'delay');
        S.block('delay2', 'delay');
//      S.block('delay3', 'delay');
        S.block('vdelay3', 'vardelay', {tap: 0.1, delay: 0.1});
        S.block('gain2', 'gain', {gain: -0.3});
        S.block('ph2', 'phasor', {frequency: 0.02});
        S.block('sin2', 'sinosc');
        S.block('gain3', 'gain', {gain: 0.9});
        S.block('noise1', 'noise', {gain: 0.9});
        S.block('gain4', 'gain', {gain: 80});
        S.wire('phasor1.phase', 'sinosc1.phase');
        S.wire('sinosc1.value', 'vol1.value');
        S.wire('vol1.value', 'aout');
        S.wire('phasor1.phase', 'delay1.value');
        S.wire('delay1.value', 'vol1.value');
        S.wire('modulator.phase', 'modsine.phase');
        S.wire('modsine.value', 'amplitude.value');
        S.wire('amplitude.value', 'phasor1.frequency');
        S.wire('konst.value', 'phasor1.frequency');
        S.wire('delay1.value', 'delay2.value');
        S.wire('vdelay3.tap', 'gain2.value');
        S.wire('delay2.value', 'vdelay3.value');
        S.wire('gain2.value', 'delay1.value');
        S.wire('ph2.phase', 'sin2.phase');
        S.wire('sin2.value', 'gain3.value');
        S.wire('gain3.value', 'gain2.gain');
        S.wire('noise1.value', 'gain2.value');
        S.wire('noise1.value', 'gain4.value');
        S.wire('gain4.value', 'modulator.frequency');

        var sys = system(S);
        S.system['konst.ain.value'] = 220;
        return S.system;
    }

    function guitest(stage) {
        var layer = stage.get('.'+UI.BLOCKS_LAYER)[0];
        var S = new System();
        var p1 = UI.makeShape(stage, S, S.block('p1', 'phasor'));
        var o1 = UI.makeShape(stage, S, S.block('o1', 'qosc'));
        var out = UI.makeShape(stage, S, S.block('out1', 'aout'));
        var d1 = UI.makeShape(stage, S, S.block('d1', 'delay'));
        var pr1 = UI.makeShape(stage, S, S.block('pr1', 'probe'));

        [p1, o1, out, d1, pr1].forEach(function (b, i) {
            b.move(50, (i+1)*50);
            layer.add(b);
        });

        layer.draw();
        return S;
    }

    return {
        test1: test1,
        test2: test2,
        junktest: junktest,
        guitest: guitest
    };

});
