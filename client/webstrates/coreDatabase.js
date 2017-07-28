'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const sharedb = require('sharedb/lib/client');

coreEvents.createEvent('receivedDocument');
coreEvents.createEvent('receivedOps');

let doc, conn;

exports.getDocument = () => doc;

/**
 * Get the element at a given path in a JsonML document.
 * @param  {JsonMLPath} path Path to follow in snapshot.
 * @return {JsonML}          Element at path in snapshot.
 * @public
 */
exports.elementAtPath = function(snapshot, path) {
// Snapshot is optional (and only used in the internal recursion).
	if (!path) {
		path = snapshot;
		snapshot = doc.data;
	}

	if (path.length > 0 && typeof path[path.length-1] === 'string') {
		return null;
	}

	var [head, ...tail] = path;
	if (!head || !snapshot[head]) {
		return snapshot;
	}

	return exports.elementAtPath(snapshot[head], tail);
};

// Having multiple subscriptions to the same webstrate causes ShareDB to behave oddly and cut
// off parts of operations for (so far) unknown reasons. As a result, getDocument will return
// nothing if a subcription to the document already exists.
const subscriptions = new Set();
Object.defineProperty(globalObject.publicObject, 'getDocument', {
	value: (webstrateId) => {
		// In case this document is transcluded as well, we recursively ask the parent for the document.
		if (!conn) {
			return window.parent.window.webstrate.getDocument(webstrateId);
		}

		if (subscriptions.has(webstrateId)) return;
		subscriptions.add(webstrateId);
		return conn.get('webstrates', webstrateId);
	}
});

exports.subscribe = (webstrateId) => {
	return new Promise((resolve, reject) => {
		// Check if we can reuse the ShareDB Database connection from a parent if we're in an iframe.
		if (coreUtils.isTranscluded() && coreUtils.sameParentDomain() && config.reuseWebsocket) {
			doc = window.parent.window.webstrate.getDocument(webstrateId);
		}

		if (doc) {
			console.log('got parent', doc.id);
		}

		// Even if we're transcluded, we won't succeed in getting a document from our parent if another
		// subscription on the same webstrate already exists.
		if (!doc) {
			// Filter out our own messages. This could be done more elegantly by parsing the JSON object
			//  and
			// then checking if the "wa" property exists, but this is a lot faster.
			// This filter is passed to coreWebsocket.copy() when getting a copy of a websocket.
			// @param  {obj} event  Websocket onmessage event.
			// @return {bool}       Whether the message should be let through to ShareDB.
			const websocket = coreWebsocket.copy(event => !event.data.startsWith('{"wa":'));

			// Create a new ShareDB connection.
			conn = new sharedb.Connection(websocket);

			// Get ShareDB document for webstrateId.
			doc = conn.get('webstrates', webstrateId);
		}

		// Subscribe to remote operations (changes to the ShareDB document).
		doc.subscribe(function(error) {
			if (error) {
				return reject(error);
			}

			coreEvents.triggerEvent('receivedDocument', doc, { static: false });

			// Generate a unique ID for this document client.
			const source = coreUtils.randomString();

			coreEvents.addEventListener('createdOps', (ops) => {
				doc.submitOp(ops, { source });
			}, coreEvents.PRIORITY.IMMEDIATE);

			doc.on('op', (ops, opsSource) => {
				// We don't broadcast a 'receivedOps' event for ops we create ourselves, as we haven't
				// received them from anybody.
				if (opsSource !== source) {
					coreEvents.triggerEvent('receivedOps', ops);
				}
			});

			resolve(doc);
		});
	});
};

exports.fetch = (webstrateId, tagOrVersion) => {
	return new Promise((resolve, reject) => {
		const msgObj = {
			wa: 'fetchdoc',
			d: webstrateId
		};

		if (/^\d/.test(tagOrVersion) && Number(tagOrVersion)) {
			msgObj.v = Number(tagOrVersion);
		} else {
			msgObj.l = tagOrVersion;
		}

		// The second parameter is `sendWhenReady` and true means to queue the message until the
		// websocket is open rather than to throw and error if the websocket isn't ready. This is not
		// part of the WebSocket specification, but has been implemented in coreWebsocket anyway.
		coreWebsocket.send(msgObj, doc => {
			coreEvents.triggerEvent('receivedDocument', doc, { static: true });
			resolve(doc);
		}, { waitForOpen: true });
	});
};

/**
 * Restore document to a previous version, either by version number or tag label.
 * Labels cannot begin with a digit whereas versions consist only of digits, so distinguishing
 * is easy.
 * This does not return a promise, as we do not have control over exactly when the document gets
 * reverted as this is ShareDB's job.
 * @param  {string} tagOrVersion Tag label or version number.
 */
exports.restore = (webstrateId, tagOrVersion) => {
	var msgObj = {
		wa: 'restore',
		d: webstrateId
	};

	if (/^\d/.test(tagOrVersion)) {
		msgObj.v = tagOrVersion;
	} else {
		msgObj.l = tagOrVersion;
	}

	coreWebsocket.send(msgObj);
};