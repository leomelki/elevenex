const calls = [
  ['machineState', 'machines:state', []],
  ['editMachine', 'machines:edit', [{ kind: 'local' }, { name: 'My Mac', hue: 'pine' }]],
  ['disconnectMachine', 'machines:disconnect', ['dev']],
  ['removeMachine', 'machines:remove', ['dev', false]],
  ['undoRemoveMachine', 'machines:undo-remove', ['undo']],
  ['dismissMachineRemoval', 'machines:dismiss-removal', ['undo']],
  ['markMachineOpened', 'machines:opened', [{ kind: 'local' }]],
  ['openMachineWindow', 'machines:new-window', [null]],
  ['sshHostSuggestions', 'machines:ssh-hosts', ['dev']],
];
module.exports = { calls, methods: [...calls.map(([name]) => name), 'onMachineStateChanged'] };
