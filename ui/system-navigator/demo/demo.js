import '../src/index.js';
import { SseNavigatorAdapter } from '../src/adapters/SseNavigatorAdapter.js';
import { buildSampleRecognition } from './sampleGraph.js';

const element = document.querySelector('#systemNavigator');
const connectionState = document.querySelector('#connectionState');
await element.ready;

const parameters = new URLSearchParams(location.search);
if (parameters.get('sample') === '1') {
  connectionState.textContent = 'SAMPLE GRAPH · LOCAL';
  await element.loadRecognitionResult(buildSampleRecognition(), {
    projectName: 'Murugan',
    snapshotId: 'sample',
    cinematic: true,
  });
} else {
  const adapter = new SseNavigatorAdapter(element, '/navigator/events');
  adapter.addEventListener('status', (event) => {
    const connected = event.detail.connected;
    connectionState.textContent = connected ? 'CLUE STREAM · CONNECTED' : 'CLUE STREAM · RECONNECTING';
    connectionState.classList.toggle('offline', !connected);
  });
  adapter.addEventListener('error', () => {
    connectionState.textContent = 'STREAM EVENT REJECTED';
    connectionState.classList.add('offline');
  });
  adapter.connect();
  await element.updateProgress({ status: 'AWAITING CLUE RECOGNITION STREAM' });
}
