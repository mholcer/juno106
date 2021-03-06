define([
    'backbone',
    'application',
    'util',
    'models/midiModel',
    'views/modal/midiAssignItemView',
    'hbs!tmpl/item/midiItemView-tmpl'
    ],
    
    function(Backbone, App, util, MidiModel, AssignItemView, Template) {
        return Marionette.ItemView.extend({
            
            className: 'midiView',
            
            template: Template,
            
            ui: {
                select: '.js-active-midi',
                midiButton: '.button--midi',
                midiLabel: '.js-midi-label',
                check: '.js-midi-check',
                error: '.js-midi-error'
            },
            
            events: {
                'change @ui.select': 'selectMidi'
            },
            
            initialize: function(options) {
                this.midi = false;
                this.inputs = [];
                this.activeDevice = null;
                this.mappings = new Backbone.Collection();
                this.menuChannel = Backbone.Wreqr.radio.channel('menu');
                this.midiChannel = Backbone.Wreqr.radio.channel('midi');
                this.messageBuffer = [];
                
                this.menuChannel.vent.on('click', function(event) {
                    if(event.indexOf('assign') !== -1) {
                        this.handleMidiLearn(event.split(':')[1]);
                    }
                }.bind(this));
                
                this.midiChannel.reqres.setHandler('midiAssignment', function(param){
                    return this.getMidiAssignment(param);
                }.bind(this));
                
                this.midiChannel.reqres.setHandler('input', function() {
                    return this.inputs.length;
                }.bind(this));
            },
            
            onShow: function() {
                this.requestMidi();
            },
            
            requestMidi: function() {
                var that = this;
                var inputs; 
                
                this.inputs = [];
                
                this.ui.midiLabel.hide();
                
                try {
                    navigator.requestMIDIAccess().then(function(access) {
                        if(access.inputs && access.inputs.size > 0) {
                            that.midi = true;
                            inputs = access.inputs.values();
                            for (input = inputs.next(); input && !input.done; input = inputs.next()) {
                                that.inputs.push(input.value);
                            }
                            that.render();
                            that.setCursor();
                            that.selectMidi();
                        } else {
                            that.render();
                        }
                    });
                } catch (e) {
                    console.log('No MIDI access');
                    this.render();
                }
            },
            
            setCursor: function() {
                $('.midi').css({
                    cursor:  'url(images/midi-cursor.png), pointer'
                });
            },
            
            selectMidi: function(e) {
                var storedMappings;
                var lastMidiDevice = window.localStorage.getItem('lastMidiDevice');
                
                if(!e && lastMidiDevice) {
                    this.activeDevice = _.findWhere(this.inputs, {name: lastMidiDevice});
                    this.ui.select.val(lastMidiDevice);
                } else {
                    this.activeDevice = _.findWhere(this.inputs, {name: this.ui.select.val() });
                    window.localStorage.setItem('lastMidiDevice', this.activeDevice.name);
                }
                
                this.activeDevice.onmidimessage = this.handleMidi.bind(this);
                
                if(window.localStorage.getItem(this.activeDevice.name)) {
                    storedMappings = JSON.parse(window.localStorage.getItem(this.activeDevice.name));
                }
                
                _.each(storedMappings, function(storedMapping) {
                    this.mappings.add(new MidiModel({
                        MSBController: storedMapping.MSBController,
                        LSBController: storedMapping.LSBController,
                        param: storedMapping.param,
                        device: storedMapping.device
                    }));
                }, this);
            },
            
            handleMidi: function(e) {
                var secondByte = e.data[1];
                var type = this.getMessageType(e);
                var update = {};
                var mapping = this.getModelForMessage(e.data[1]);
                var MSB;
                
                if(type === 'CC') {
                    // If it's a 14-bit MIDI message, we need to get the MSB and LSB
                    if(mapping && mapping.get('LSBController') !== null &&
                        this.messageBuffer.length === 0) {
                        this.messageBuffer.push(e.data);
                    } else {
                        if(this.messageBuffer.length > 0) {
                            this.messageBuffer.push(e.data);
                            
                            _.each(this.messageBuffer, function(message, i) {
                                if(message[1] === mapping.get('MSBController')) {
                                    update.MSB = this.messageBuffer[i][1];
                                    update.MSBValue = this.messageBuffer[i][2];
                                } else if (message[1] === mapping.get('LSBController')) {
                                    update.LSB = this.messageBuffer[i][1];
                                    update.LSBValue = this.messageBuffer[i][2];
                                }
                             }, this);
                             
                            this.messageBuffer = [];
                        } else {
                            update = {
                                MSB: e.data[1],
                                MSBValue: e.data[2]
                            };
                        }
                        this.handleCCUpdate(update);
                    }
                } else if(type === 'noteOn' || type === 'noteOff') {
                    this.midiChannel.vent.trigger('message', {type: type, value: secondByte});
                }
            },
            
            getMidiAssignment: function(param) {
                var midiObject = this.mappings.findWhere({param: param, device: this.activeDevice.name});
                if(midiObject) {
                    return midiObject.get('MSBController') + (midiObject.get('LSBController') ?
                        ', ' + midiObject.get('LSBController') : '');
                }
            },
            
            handleMidiLearn: function(param) {
                var messages = [];
                var firstByte;
                var listening = false;
                
                var assignModal = new AssignItemView({
                    param: util.parseParamName(param),
                });
                
                assignModal.onDestroy = function() {
                    if(listening) {
                        this.activeDevice.onmidimessage = this.handleMidi.bind(this);
                    }
                }.bind(this);
                
                App.modal.show(assignModal);
                listening = true;
                
                this.activeDevice.onmidimessage = function(e) {
                    if(this.getMessageType(e) !== 'CC') {
                        return;
                    }
                    
                    firstByte = +(e.data[0].toString(2).slice(0, 4));
                    // Listen to the first two messages to allow for 14-bit MIDI
                    if(messages.length < 2) {
                        messages.push(e.data);
                    } else {
                        this.activeDevice.onmidimessage = this.handleMidi.bind(this);
                        this.assignMidiCC(messages, param);
                        assignModal.success();
                    }
                }.bind(this);
            },
            
            assignMidiCC: function(midiMessage, param) {
                var controllers = util.determineMSB(midiMessage);
                
                if(controllers.MSB === controllers.LSB) {
                    controllers.LSB = null;
                }
                
                // If the synth parameter or the CC were previously assigned,
                // clear the old mapping
                this.removeOldMapping(controllers.MSB, param);
                
                this.mappings.add(new MidiModel({
                    device: this.activeDevice.name,
                    MSBController: controllers.MSB,
                    LSBController: controllers.LSB,
                    param: param
                }));
                
                window.localStorage.setItem(this.activeDevice.name, JSON.stringify(this.mappings));
            },
            
            removeOldMapping: function(midiMessage, param) {
                var previousCCMapping = this.getModelForMessage(midiMessage);
                var previousParamMapping = this.getModelForParam(param);
                if(previousCCMapping) {
                    this.mappings.remove(previousCCMapping);
                }
                if(previousParamMapping) {
                    this.mappings.remove(previousParamMapping);
                }
            },
            
            getMessageType: function(e) {
                var firstByte = +(e.data[0].toString(2).slice(0, 4));
                var secondByte = e.data[1];
                var thirdByte = e.data[2];
                
                if(firstByte === 1000 || (firstByte === 1001 && thirdByte === 0)) {
                    return 'noteOff';
                } else if(firstByte === 1001) {
                     return 'noteOn';
                } else if(firstByte === 1011 && secondByte < 120) {
                    return 'CC';
                } else if(firstByte === 1110) {
                    return 'pitchBend';
                }
            },
            
            handleCCUpdate: function(message) {
                var mapping;
                var value;
                
                mapping = this.getModelForMessage(message.MSB);
                
                if(mapping) {
                    value = mapping.getValue(message);
                    this.midiChannel.vent.trigger('message', {type: 'CC', param: mapping.get('param'), value: value});
                }
            },
            
            getModelForMessage: function(controller) {
                return this.mappings.findWhere({
                    MSBController: controller
                }) || this.mappings.findWhere({
                    LSBController: controller
                });
            },
            
            getModelForParam: function(param) {
                return this.mappings.findWhere({
                    param: param
                });
            },
            
            serializeData: function() {
                return {
                    midi: this.midi,
                    inputs: this.inputs
                };
            }
            
        });
    });