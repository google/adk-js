/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createUserContent} from '@google/genai';

import {LiveRequest, LiveRequestQueue} from '../../src/agents/live_request_queue.js';

describe('LiveRequestQueue', () => {
  it('should handle sendContent', async () => {
    const queue = new LiveRequestQueue();
    const content = createUserContent('content test');
    queue.sendContent(content);
    expect(await queue.get()).toEqual({content});
  });

  it('should handle sendRealtime', async () => {
    const queue = new LiveRequestQueue();
    const blob = {mimeType: 'audio/wav', data: 'base64data'};
    queue.sendRealtime(blob);
    expect(await queue.get()).toEqual({blob});
  });

  it('should handle sendActivityStart', async () => {
    const queue = new LiveRequestQueue();
    queue.sendActivityStart();
    const request = await queue.get();
    expect(request).toEqual({activityStart: {}});
  });

  it('should handle sendActivityEnd', async () => {
    const queue = new LiveRequestQueue();
    queue.sendActivityEnd();
    const request = await queue.get();
    expect(request).toEqual({activityEnd: {}});
  });

  it('should handle close', async () => {
    const queue = new LiveRequestQueue();
    queue.close();
    expect(await queue.get()).toEqual({close: true});
  });

  it('should queue multiple requests and get them in order', async () => {
    const queue = new LiveRequestQueue();
    const request1: LiveRequest = {content: createUserContent('req1')};
    const request2: LiveRequest = {content: createUserContent('req2')};
    queue.send(request1);
    queue.send(request2);
    expect(await queue.get()).toEqual(request1);
    expect(await queue.get()).toEqual(request2);
  });


  it('should handle non-blocking read to be resolved later', async () => {
    const queue = new LiveRequestQueue();
    const getPromise1 = queue.get();
    const getPromise2 = queue.get();

    const request1: LiveRequest = {content: createUserContent('req1')};
    const request2: LiveRequest = {content: createUserContent('req2')};

    queue.send(request1);
    queue.send(request2);
    expect(await getPromise1).toEqual(request1);
    expect(await getPromise2).toEqual(request2);
  });

  it('should read until closed using a for loop', async () => {
    const queue = new LiveRequestQueue();
    const expectedRequests = [
      {content: createUserContent('req1')},
      {content: createUserContent('req2')},
      {content: createUserContent('req3')},
      {close: true},
    ];

    // Send the requests with a random delay.
    const sendRequestsPromise = (async () => {
      for (const request of expectedRequests) {
        await new Promise(resolve => {
          setTimeout(resolve, Math.random() * 10);
        });
        queue.send(request);
      }
    })();

    // Async read in a for loop.
    const receivedRequests: LiveRequest[] = [];
    for await (const request of queue) {
      receivedRequests.push(request);
    }

    // Wait for the all requests to be sent.
    await sendRequestsPromise;
    expect(receivedRequests).toEqual(expectedRequests);
  });

  it('should resolve all pending gets on close', async () => {
    const queue = new LiveRequestQueue();
    const getPromise1 = queue.get();
    const getPromise2 = queue.get();
    const getPromise3 = queue.get();

    queue.close();

    expect(await getPromise1).toEqual({close: true});
    expect(await getPromise2).toEqual({close: true});
    expect(await getPromise3).toEqual({close: true});
  });

  it('should immediately return close after queue is closed', async () => {
    const queue = new LiveRequestQueue();
    queue.close();
    expect(await queue.get()).toEqual({close: true});
    expect(await queue.get()).toEqual({close: true});
  });

  it('should not send to a closed queue', async () => {
    const queue = new LiveRequestQueue();
    queue.close();
    expect(() => {
      queue.send({content: createUserContent('test')});
    }).toThrowError('Cannot send to a closed queue.');
  });

  it('should drain remaining items after close, then return close signal',
     async () => {
       const queue = new LiveRequestQueue();
       const request1 = {content: createUserContent('item1')};
       const request2 = {content: createUserContent('item2')};
       const request3 = {content: createUserContent('item3')};

       queue.send(request1);
       queue.send(request2);
       queue.send(request3);

       // No pending gets when close is called
       queue.close();

       // Should be able to retrieve all items sent before close
       expect(await queue.get()).toEqual(request1);
       expect(await queue.get()).toEqual(request2);
       expect(await queue.get()).toEqual(request3);

       // Subsequent gets should receive close signal
       expect(await queue.get()).toEqual({close: true});
       expect(await queue.get()).toEqual({close: true});
     });
});
