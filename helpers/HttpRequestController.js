"use strict";

var archiver = require('archiver');
var crypto = require('crypto')
var fs = require('fs');
var jsonml = require('jsonml-tools');
var jsonmlParse = require('jsonml-parse');
var mime = require('mime-types');
var request = require('request');
var shortId = require('shortid');
var tmp = require('tmp');
var yauzl = require('yauzl');
var SELFCLOSING_TAGS = ["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen",
	"link", "menuitem", "meta", "param", "source", "track", "wbr"];

module.exports = function(documentManager, permissionManager, assetManager) {
	var module = {};

	/**
	 * Handles requests to "/" and redirects them to "/frontpage".
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.rootRequestHandler = function(req, res) {
		return res.redirect('/frontpage');
	};

	/**
	 * Handles request without trailing slashes and appends the trailing slash.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.trailingSlashAppendHandler = function(req, res) {
		var queryIndex = req.url.indexOf("?");
		var query = queryIndex !== -1? req.url.substring(queryIndex) : "";
		res.redirect(req.path + "/" + query);
	};

	/**
	 * Middleware for extracting parameters from the query string and appending them to the request
	 * object.
	 * @param {obj}       req  Express request object.
	 * @param {obj}       res  Express response object.
	 * @param  {Function} next Callback
	 * @public
	 */
	module.extractQuery = function(req, res, next) {
		var [webstrateId, versionOrTag, assetName] = Object.keys(req.params).map(i => req.params[i]);
		var { version, tag } = extractVersionOrTag(versionOrTag);
		Object.assign(req, { webstrateId, versionOrTag, assetName, version, tag });
		next();
	};

	/**
	 * Extracts a version or tag from a string.
	 * @param  {string} versionOrTag Version or tag.
	 * @return {obj}                 Object with one property, either version or tag.
	 * @private
	 */
	function extractVersionOrTag(versionOrTag) {
		var version, tag;
		if (versionOrTag === "") {
			version = "";
		} else if (/^\d/.test(versionOrTag)) {
			version = Number(versionOrTag) || undefined;
		} else {
			tag = versionOrTag;
		}
		return { version, tag };
	}

	/**
	 * Primary request handler.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.requestHandler = function(req, res) {
		// Support for legacy syntax: /<webstrateId>?v=<versionOrtag>, which is equivalent to
		// /<webstrateId>/<versionOrTag>/?copy.
		if (req.query.v && !req.versionOrTag) {
			return res.redirect(`/${req.webstrateId}/${req.query.v}/?copy`);
		}

		return documentManager.getDocument({
			webstrateId: req.webstrateId,
			version: req.version,
			tag: req.tag
		}, function(err, snapshot) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			req.user.permissions = permissionManager.getUserPermissionsFromSnapshot(req.user.username,
				req.user.provider, snapshot);

			// If the webstrate doesn't exist, write permissions are required to create it.
			if (!snapshot.type && !req.user.permissions.includes("w")) {
				return res.status(403).send("Insufficient permissions.");
			}

			// If the webstrate does exist, read permissions are required to access it (or any of its
			// assets).
			if (!req.user.permissions.includes("r")) {
				return res.status(403).send("Insufficient permissions.");
			}

			// Requesting an asset.
			if (req.assetName) {
				return assetManager.getAsset({
					webstrateId: req.webstrateId,
					assetName: req.assetName,
					version: snapshot.v
				}, function(err, asset) {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}

					if (!asset) {
						return res.status(404).send(`Asset "${req.assetName}" not found.`);
					}

					res.type(asset.mimeType);

					// `/<webstrateId>/<asset>` may not always refer to the same asset, but to optimize rapid
					// requests, we set a maxAge anyway. If the requested asset includes a specific version,
					// it'll always refer to the same thing, allowing us to set a longer maxAge.
					var maxAge = req.version ? (config.maxAge || "1d") : "1m";
					res.sendFile(APP_PATH + "/uploads/" + asset.fileName, { maxAge });
				});
			}

			// Requesting current document version number by calling `/<id>?v` or `/<id>?version`.
			if ("v" in req.query || "version" in req.query) {
				return serveVersion(req, res, snapshot);
			}

			// Requesting a list of operations by calling `/<id>?ops`.
			if ("ops" in req.query) {
				return serveOps(req, res);
			}

			// Requesting a list of tags by calling `/<id>?tags`.
			if ("tags" in req.query) {
				return serveTags(req, res);
			}

			// Requesting a list of assets by calling `/<id>?assets`.
			if ("assets" in req.query) {
				return serveAssets(req, res);
			}

			// Requesting a JsonML version of the webstrate by calling `/<id>?json`.
			if ("json" in req.query) {
				return serveJsonMLWebstrate(req, res, snapshot);
			}

			// Requesting a raw version of the webstrate (i.e. a server-generated HTML file) by calling
			// `/<id>?raw`.
			if ("raw" in req.query) {
				return serveRawWebstrate(req, res, snapshot);
			}

			if ("dl" in req.query) {
				return serveCompressedWebstrate(req, res, snapshot);
			}

			if ("tokens" in req.query) {
				return serveTokenList(req, res);
			}

			// Requesting a copy of the webstrate.
			if ("copy" in req.query) {
				var defaultPermissions = permissionManager.getDefaultPermissions(req.user.username,
					req.user.provider);

				// If the user has no default write permissions, they're not allowed to create documents.
				if (!defaultPermissions.includes("w")) {
					return res.status(403).send("Write permissions are required to create a new document");
				}

				return copyWebstrate(req, res, snapshot);
			}

			// Requesting to restore document to a previous version or tag by calling:
			// `/<id>/?restore=<version|tag>`.
			if ("restore" in req.query) {
				if (!req.user.permissions.includes("w")) {
					return res.status(403).send("Write permissions are required to restore a document");
				}

				return restoreWebstrate(req, res, snapshot);
			}

			if ("delete" in req.query) {
				if (!req.user.permissions.includes("w")) {
					return res.status(403).send("Write permissions are required to delete a document");
				}

				return deleteWebstrate(req, res);
			}

			// We don't need to check for "static" in req.query, because this happens on the client side.

			return serveWebstrate(req, res);
		});

	};

	function createNewWebstrate(req, res) {
		// If a specific version is requested, we create a new webstrate from the requested
		// version with a name of the format /<id>-<version|tag>-<random string> and redirect the
		// user to it. Only one of `version` and `tag` will be defined.
		var newWebstrateId = req.webstrateId + "-" + (req.version || req.tag)
			+ "-" + shortId.generate();
		return documentManager.createNewDocument({
			webstrateId: newWebstrateId,
			prototypeId: req.webstrateId,
			version: req.version, tag: req.tag
		}, function(err, newWebstrateId) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}
			res.redirect("/" + newWebstrateId);
		});
	}

	/**
	 * Requesting current document version number by calling `/<id>?v`.
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function serveVersion(req, res, snapshot) {
		res.json({ version: snapshot.v });
	}

	/**
	 * Requesting a list of operations by calling: `/<id>?ops`.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveOps(req, res) {
		documentManager.getOps({
			webstrateId: req.webstrateId,
			version: req.version
		}, function(err, ops) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				res.json(ops);
			});
		}

	/**
	 * Requesting a list of tags by calling `/<id>?tags`.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveTags(req, res) {
		documentManager.getTags(req.webstrateId, function(err, tags) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}
			res.json(tags);
		});
	}

	/**
	 * Requesting a list of assets by calling `/<id>?assets`.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveAssets(req, res) {
		assetManager.getAssets(req.webstrateId, function(err, assets) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}
			res.json(assets);
		});
	}

	function serveJsonMLWebstrate(req, res, snapshot) {
		res.send(snapshot.data);
	}

	/**
	 * Requesting a raw webstrate by calling `/<id>?raw`.
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function serveRawWebstrate(req, res, snapshot) {
		res.send("<!doctype html>\n" + jsonml.toXML(snapshot.data, SELFCLOSING_TAGS));
	}

	/**
	 * Requesting to download a webstraet by calling `/<id>?dl`.
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function serveCompressedWebstrate(req, res, snapshot) {
		assetManager.getCurrentAssets(req.webstrateId, function(err, assets) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			var format = req.query.dl === 'tar' ? 'tar' : 'zip';
			var archive = archiver(format, { store: true });
			archive.append("<!doctype html>\n" + jsonml.toXML(snapshot.data, SELFCLOSING_TAGS),
				{ name: `${req.webstrateId}/index.html` });

			assets.forEach(function(asset) {
				var filePath = `${assetManager.UPLOAD_DEST}${asset.fileName}`;
				if (fs.existsSync(filePath)) {
					archive.file(filePath, { name: `${req.webstrateId}/${asset.originalFileName}` });
				} else {
					console.warn(`Asset ${filePath} (${asset.originalFileName}) for Webstrate ` +
						`${req.webstrateId} doesn't exist. Deleting it from database.`);
					// The deletion happens async, but there's no reason to make the user wait for it.
					assetManager.deleteAssetFromDatabase(asset.fileName);
				}
			});
			archive.finalize();
			var potentialTag = req.tag ? ("-" + req.tag) : "";
			res.attachment(`${req.webstrateId}-${snapshot.v}${potentialTag}.${format}`);
			archive.pipe(res);
		});
	}

	function serveTokenList(req, res) {
		res.json(permissionManager.getAccessTokens(req.webstrateId));
	}

	/**
	 * Copy a webstrate by calling `/<id>?copy[=newWebstrateId]`.
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function copyWebstrate(req, res, snapshot) {
		var webstrateId = req.query.copy;

		// If user doesn't have write permissions to the docuemnt, add them if the user is logged in,
		// otherwise just delete all permissions on the new document.
		if (!req.user.permissions.includes("w")) {
			if (req.user.username === "anonymous" && req.user.provider === "") {
				snapshot = permissionManager.clearPermissionsFromSnapshot(snapshot);
			} else {
				snapshot = permissionManager.addPermissionsToSnapshot(req.user.username,
					req.user.provider, "rw", snapshot);
			}
		}

		documentManager.createNewDocument({ webstrateId, snapshot }, function(err, webstrateId) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			// Also copy over all the assets. Note that we pass through snapshot.v, because we know this
			// will always be set, even if no version is specified, or the user is accessing the webstrate
			// through a tag.
			assetManager.copyAssets({
				fromWebstrateId: req.webstrateId,
				toWebstrateId: webstrateId,
				version: snapshot.v
			}, function(err) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				return res.redirect(`/${webstrateId}/`);
			})
		});
	}

	/**
	 * Restore a webstrate to a previous version or tag and redirect the user to the document.
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function restoreWebstrate(req, res, snapshot) {
		// There shouldn't be a version or tag in the first part of the URL, i.e.
		// `/<id>/<version|tag>/?restore` is not allowed.
		if (req.version || req.tag) {
			return res.status(409).send("Can not restore a document at a previous tag or version." +
				` Did you mean <code><a href="/${req.webstrateId}/?restore=${req.versionOrTag}">` +
				`/${req.webstrateId}/?restore=${req.versionOrTag}</a></code>?`);
		}

		// A version or tag in the query string, however, should be defined.
		var { version, tag } = extractVersionOrTag(req.query.restore);
		if (!version && !tag) {
			return res.status(409).send("No tag or version defined.")
		}

		// Ops always have a source (src) set by the client when the op comes in. This source is
		// usually the websocket clientId, but this is a regular HTTP request, so there is no
		// clientId. We'll just use the userId instead.
		var source = req.user.userId;
		return documentManager.restoreDocument({ webstrateId: req.webstrateId, version, tag },
			source, function(err, newVersion) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			// Also restore assets, so the restored version shows the old assets, not the new ones.
			assetManager.restoreAssets({ webstrateId: req.webstrateId, version, tag, newVersion },
			function(err) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				return res.redirect(`/${req.webstrateId}/`);
			});
		});
	}

	/**
	 * Delete the assets of a webstrate, then the delete the webstrate itself, and redirect the user
	 * to the root (`/`).
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function deleteWebstrate(req, res) {
		var source = req.user.userId;
		return assetManager.deleteAssets(req.webstrateId, function(err) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}

				documentManager.deleteDocument(req.webstrateId, source, function(err) {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}
					res.redirect("/");
				});
		});
	}

	/**
	 * Requesting a webstrate by calling /<id>.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveWebstrate(req, res) {
		var maxAge = config.maxAge || "1d";
		return res.sendFile(APP_PATH + "/static/client.html", { maxAge });
	}

	/**
	 * Applies callback recursively to every string in a nested data structure.
	 * @param  {list}   xs         List to recurse.
	 * @param  {Function} callback Function to apply to each string.
	 * @return {list}              Resulting data structure.
	 */
	function recurse(xs, callback) {
		return xs.map(function(x) {
			if (typeof x === "string") return callback(x, xs);
			if (Array.isArray(x)) return recurse(x, callback);
			return x;
		});
	}

	/**
	 * Convert HTML string to JsonML structure.
	 * @param  {string}   html     HTML string.
	 * @param  {Function} callback Callback.
	 * @return {jsonml}            (Async) JsonML object.
	 */
	function htmlToJson(html, callback) {
		jsonmlParse(html.trim(), function(err, jsonml) {
			if (err) return callback(err);
			jsonml = recurse(jsonml, function(str, parent) {
				if (["script", "style"].includes(parent[0].toLowerCase())) { return str; }
				return str.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
			});
			callback(null, jsonml);
		}, { preserveEntities: true });
	}

	/**
	 * Transform a readable straem into a string
	 * @param  {ReadableStream} stream Stream to read from.
	 * @param  {Function} callback     Callback to call when stream has been read.
	 * @return {string}                (async) String read from stream.
	 * @private
	 */
	function streamToString(stream, callback) {
		let str = "";
		stream.on('data', chunk => str += chunk);
		stream.on('end', () => callback(str));
	}

	/**
	 * Handles requests to "/new".
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.newWebstrateRequestHandler = function(req, res) {
		// Support for legacy syntax: /new?prototype=<webstrateId>&v=<versionOrTag>&id=<newWebstrateId>,
		// which is equivalent to /<webstrateId>/<versionOrTag>/?copy=<newWebstrateId>.

		if ("prototypeUrl" in req.query) {
			return request({url: req.query.prototypeUrl, encoding: 'binary' }, function(err, response, body) {
				if (!err && response.statusCode !== 200) {
					err = new Error("Invalid request. Received: " +
						response.statusCode + " " + response.statusMessage);
				}
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				if (response.headers['content-type'] === 'application/zip') {
					return tmp.file((err, filePath, fd, cleanupFileCallback) => {
						return fs.writeFile(filePath, body, 'binary', err => {
							if (err) {
								console.error(err);
								return cleanupFileCallback();
							}
							yauzl.open(filePath, { lazyEntries: true } , (err, zipFile) => {
								if (err) {
									console.error(err);
									cleanupFileCallback();
								}

								let webstrateId, htmlDocumentFound = false;
								const assets = [];
								zipFile.on("entry", entry => {
									if (/\/$/.test(entry.fileName)) {
										// Directory file names end with '/'.
										// Note that entires for directories themselves are optional.
										// An entry's fileName implicitly requires its parent directories to exist.
										zipFile.readEntry();
									} else {
										// file entry
										zipFile.openReadStream(entry, (err, readStream) => {
											if (err) return console.error(err);
											readStream.on("end", function() {
												zipFile.readEntry();
											});

											if (!htmlDocumentFound && entry.fileName.match(/index\.html?$/i)) {
												htmlDocumentFound = true;
												streamToString(readStream, htmlDoc => {
													htmlToJson(htmlDoc, function(err, jsonml) {
														if (err) return;
														documentManager.createNewDocument({
															webstrateId: req.query.id,
															snapshot: {
																type: 'http://sharejs.org/types/JSONv0',
																data: jsonml
															}
														}, function(err, _webstrateId) {
															if (err) return;
															webstrateId = _webstrateId;
														});
													});
												});
											}
											else {
												crypto.pseudoRandomBytes(16, (err, raw) => {
													const fileName =  raw.toString('hex');
													const filePath = assetManager.UPLOAD_DEST + fileName;
													const writeStream = fs.createWriteStream(filePath);
													readStream.pipe(writeStream);
													assets.push({
														filename: fileName,
														originalname: entry.fileName.match(/([^\/]+)$/)[0],
														size: entry.uncompressedSize,
														mimetype: mime.lookup(entry.fileName)
													});
												});
											}
										});
									}
								});

								function addAssetsToWebstrateOrDeleteTheAssets() {
									if (!webstrateId) {
										assets.forEach(asset => {
											fs.unlink(assetManager.UPLOAD_DEST + asset.filename, () => {});
										});
										return res.status(409).send(htmlDocumentFound
											? "Unable to create webstrate from index.html file."
											: "No index.html found.");
									}

									var source = `${req.user.userId} (${req.remoteAddress})`;
									assetManager.addAssets(webstrateId, assets, source, (err, assetRecords) => {
										res.redirect(`/${webstrateId}/`);
									});
								}

								zipFile.once("end", function() {
									zipFile.close();
									cleanupFileCallback();

									if (webstrateId) {
										return addAssetsToWebstrateOrDeleteTheAssets();
									}

									// If no webstrateId exists, we're waiting for MongoDB, so we'll wait 500ms.
									setTimeout(addAssetsToWebstrateOrDeleteTheAssets, 500);
								});

								zipFile.readEntry();
							});
						});
					});
				}

				// `startsWith` and not a direct match, because the content-type often (always?) is followed
				// by a charset declaration, which we don't care about.
				if (response.headers['content-type'].startsWith('text/html')) {
					return htmlToJson(body, function(err, jsonml) {
						if (err) {
							console.error(err);
							return res.status(409).send(String(err));
						}
						documentManager.createNewDocument({
							webstrateId: req.query.id,
							snapshot: {
								type: 'http://sharejs.org/types/JSONv0',
								data: jsonml
							}
						}, function(err, webstrateId) {
							if (err) {
								console.error(err);
								return res.status(409).send(String(err));
							}
							res.redirect(`/${webstrateId}/`);
						});
					});
				}

				res.status(405).send('Can only prototype from text/html or application/zip sources. ' +
					'Received file with content-type: ' + response.headers['content-type']);
			});
		}

		if (req.query.prototype) {
			var path = `/${req.query.prototype}/`;
			if (req.query.v) {
				path += `${req.query.v}/`;
			}
			path += "?copy";
			if (req.query.id) {
				path += `=${req.query.id}`;
			}
			return res.redirect(path);
		}

		var defaultPermissions = permissionManager.getDefaultPermissions(req.user.username,
			req.user.provider);

		// If the user has no default write permissions, they're not allowed to create documents.
		if (!defaultPermissions.includes("w")) {
			return res.status(403).send("Write permissions are required to create a new document");
		}

		var webstrateId = shortId.generate();
		res.redirect(`/${webstrateId}/`);
	}

	return module;
};