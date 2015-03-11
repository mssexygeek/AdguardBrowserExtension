/**
 * This file is part of Adguard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * Adguard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Adguard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Adguard Browser Extension.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Initializing required libraries for this file.
 * require method is overridden in Chrome extension (port/require.js).
 */
var Log = require('utils/log').Log;
var Utils = require('utils/common').Utils;
var LS = require('utils/local-storage').LS;
var Prefs = require('prefs').Prefs;
var AntiBannerFiltersId = require('utils/common').AntiBannerFiltersId;
var FS = require('utils/file-storage').FS;
var FilterStorage = require('filter/storage').FilterStorage;
var CollectionUtils = require('utils/common').CollectionUtils;
var Promise = require('utils/promises').Promise;

/**
 * Service that manages extension version information and handles
 * extension update. For instance we may need to change storage schema on update.
 */
exports.ApplicationUpdateService = {

	/**
	 * Returns extension run info
	 * @returns {{isFirstRun: boolean, isUpdate: (boolean|*), currentVersion: (exports.Prefs.version|*), prevVersion: *}}
	 */
	getRunInfo: function () {

		var currentVersion = Prefs.version;
		var prevVersion = Utils.getAppVersion();
		Utils.setAppVersion(currentVersion);

		var isFirstRun = currentVersion != prevVersion && !prevVersion;
		var isUpdate = currentVersion != prevVersion && prevVersion;

		return {
			isFirstRun: isFirstRun,
			isUpdate: isUpdate,
			currentVersion: currentVersion,
			prevVersion: prevVersion
		}
	},

	/**
	 * Handle extension update
	 * @param runInfo   Run info
	 * @param callback  Called after update was handled
	 */
	onUpdate: function (runInfo, callback) {

		var methods = [];
		if (Utils.isGreaterVersion("1.0.1.0", runInfo.prevVersion)) {
			methods.push(this._onUpdateToSaveFilterRulesToDifferentFiles);
		}
		if (Utils.isGreaterVersion("1.0.3.0", runInfo.prevVersion)) {
			methods.push(this._onUpdateToMultiplySubscriptions);
		}
		if (Utils.isGreaterVersion("2.0.0", runInfo.prevVersion)) {
			methods.push(this._onUpdateRemoveIpResolver);
		}

		var dfd = this._executeMethods(methods);
		dfd.then(callback);
	},

	/**
	 * Helper to execute deferred objects
	 *
	 * @param methods Methods to execute
	 * @returns {Deferred}
	 * @private
	 */
	_executeMethods: function (methods) {

		var mainDfd = new Promise();

		var executeNextMethod = function () {
			if (methods.length == 0) {
				mainDfd.resolve();
			} else {
				var method = methods.shift();
				var dfd = method.call(this);
				dfd.then(executeNextMethod);
			}
		}.bind(this);

		executeNextMethod();

		return mainDfd;
	},

	/**
	 * Earlier filters rules were saved to filters.ini.
	 * Now filters rules save to filter_1.txt, filter_2.txt, ...
	 * @private
	 */
	_onUpdateToSaveFilterRulesToDifferentFiles: function () {

		Log.info('Call update to version 1.0.1.0');

		var updateDfd = new Promise();

		FilterStorage.loadFromDisk(function (filters) {

			var adguardFilters = Object.create(null);

			var processNextFilter = function () {
				if (filters.length == 0) {
					//update adguard-filters in local storage for next update iteration
					LS.setItem('adguard-filters', JSON.stringify(adguardFilters));

					//cleanup old file
					var removeCallback = function () {
					};
					FS.removeFile(FilterStorage.FILE_PATH, removeCallback, removeCallback);
					updateDfd.resolve();
				} else {
					var filter = filters.shift();
					adguardFilters[filter.filterId] = {
						version: filter.version,
						lastCheckTime: filter.lastCheckTime,
						lastUpdateTime: filter.lastUpdateTime,
						disabled: filter.disabled
					};
					var dfd = new Promise();
					var rulesText = CollectionUtils.getRulesText(filter.filterRules);
					FilterStorage.saveFilterRules(filter.filterId, rulesText, dfd.resolve);
					dfd.then(processNextFilter);
				}
			};

			processNextFilter();
		});

		return updateDfd;
	},

	/**
	 * Update to version with filter subscriptions
	 *
	 * version 1.0.3.0
	 * @private
	 */
	_onUpdateToMultiplySubscriptions: function () {

		Log.info('Call update to version 1.0.3.0');

		if ('adguard-filters' in LS.storage) {
			this._saveInstalledFiltersOnUpdate();
			this._saveFiltersVersionInfoOnUpdate();
			LS.removeItem('adguard-filters');
		}

		var dfd = new Promise();
		dfd.resolve();
		return dfd;
	},

	/**
	 * Update to version without ip-resolve
	 *
	 * version 2.0.0
	 * @private
	 */
	_onUpdateRemoveIpResolver: function () {

		Log.info('Call update to version 1.0.3.0');

		LS.removeItem('ip-cache');

		var dfd = new Promise();
		dfd.resolve();
		return dfd;
	},

	/**
	 * Mark 'adguard-filters' as installed and loaded on extension version update
	 * @private
	 */
	_saveInstalledFiltersOnUpdate: function () {

		var FilterLSUtils = require('filter/antibanner').FilterLSUtils;
		var adguardFilters = JSON.parse(LS.getItem('adguard-filters')) || Object.create(null);

		for (var filterId in adguardFilters) {
			var filterInfo = adguardFilters[filterId];
			if (filterId == AntiBannerFiltersId.USER_FILTER_ID || filterId == AntiBannerFiltersId.WHITE_LIST_FILTER_ID) {
				continue;
			}
			var filter = {
				filterId: filterId,
				loaded: true
			};
			if (!filterInfo.disabled) {
				filter.installed = true;
				filter.enabled = true;
			}
			if (filterId == AntiBannerFiltersId.ACCEPTABLE_ADS_FILTER_ID) {
				filter.installed = true;
			}
			FilterLSUtils.updateFilterStateInfo(filter);
		}
	},

	/**
	 * Update 'adguard-filters' version and last check and update time
	 * @private
	 */
	_saveFiltersVersionInfoOnUpdate: function () {

		var FilterLSUtils = require('filter/antibanner').FilterLSUtils;
		var adguardFilters = JSON.parse(LS.getItem('adguard-filters')) || Object.create(null);

		for (var filterId in adguardFilters) {
			var filterInfo = adguardFilters[filterId];
			var filter = {
				filterId: filterId,
				version: filterInfo.version,
				lastCheckTime: filterInfo.lastCheckTime,
				lastUpdateTime: filterInfo.lastUpdateTime
			};
			FilterLSUtils.updateFilterVersionInfo(filter);
		}
	}
};


