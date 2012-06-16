package('main', ['sriku.wireup.system', 'sriku.wireup.tests', 'sriku.wireup.ui', 'Kinetic'], 
        function (System, Tests, UI, Kinetic) {
            var log = (function () {
                var lognode = document.getElementById('log');
                return function (txt) {
                    var pre = document.createElement('pre');
                    pre.innerText = txt;
                    lognode.insertAdjacentElement('beforeend', pre);
                };
            }());

            var context = new webkitAudioContext();
            jsnode = context.createJavaScriptNode(1024); // hold global reference.

            var stage = new Kinetic.Stage({
                container: "container",
                width: document.getElementById('container').offsetWidth,
                height: document.getElementById('container').offsetHeight
            });

            var layer = new Kinetic.Layer({ name: UI.BLOCKS_LAYER });

            stage.add(layer);
            //                var S = Tests.guitest(stage);
            //                stage.draw();
            document.getElementById('render').onclick = function () {
                jsnode.onaudioprocess = S.system;
                jsnode.connect(context.destination);
            };

            var S = new System();
            var blockTypes = package('sriku.wireup.blocks.*');
            var k = 1;
            Object.keys(blockTypes).forEach(function (b, i) {
                var e = document.createElement('button');
                e.innerText = b;
                e.onclick = function (evt) {
                    var sh = UI.makeShape(stage, S, S.block('b'+(k++), b));
                    sh.move(100, 100);
                    layer.add(sh);
                    layer.draw();
                };
                document.getElementById('create').insertAdjacentElement('beforeend', e);
            });

        }
);

