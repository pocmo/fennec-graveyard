/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { AppConstants } = ChromeUtils.import(
  "resource://gre/modules/AppConstants.jsm"
);
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  EventDispatcher: "resource://gre/modules/Messaging.jsm",
  OS: "resource://gre/modules/osfile.jsm",
  PrivacyFilter: "resource://gre/modules/sessionstore/PrivacyFilter.jsm",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.jsm",
  SessionHistory: "resource://gre/modules/sessionstore/SessionHistory.jsm",
  SharedPreferences: "resource://gre/modules/SharedPreferences.jsm",
  Utils: "resource://gre/modules/sessionstore/Utils.jsm",
});

XPCOMUtils.defineLazyModuleGetter(
  this,
  "Log",
  "resource://gre/modules/AndroidLog.jsm",
  "AndroidLog"
);

function dump(a) {
  Services.console.logStringMessage(a);
}

let loggingEnabled = false;

function log(a) {
  if (!loggingEnabled) {
    return;
  }
  Log.d("SessionStore", a);
}

// -----------------------------------------------------------------------
// Session Store
// -----------------------------------------------------------------------

const INVALID_TAB_ID = -1;
const INVALID_TAB_INDEX = -1;

const STATE_STOPPED = 0;
const STATE_RUNNING = 1;
const STATE_QUITTING = -1;
const STATE_QUITTING_FLUSHED = -2;

const PREFS_RESTORE_FROM_CRASH = "browser.sessionstore.resume_from_crash";
const PREFS_MAX_CRASH_RESUMES = "browser.sessionstore.max_resumed_crashes";
const PREFS_MAX_TABS_UNDO = "browser.sessionstore.max_tabs_undo";

const MINIMUM_SAVE_DELAY = 2000;
const SAVE_INTERVAL_PRIVATE_TABS = 500;

function SessionStore() {}

function sendEvent(browser, event) {
  let evt = new Event(event, { bubbles: true, cancelable: false });
  browser.dispatchEvent(evt);
}

SessionStore.prototype = {
  classID: Components.ID("{8c1f07d6-cba3-4226-a315-8bd43d67d032}"),

  QueryInterface: ChromeUtils.generateQI([
    Ci.nsISessionStore,
    Ci.nsIObserver,
    Ci.nsISupportsWeakReference,
  ]),

  _windows: {},
  _lastSaveTime: 0,
  _lastQueuedSaveTime: 0,
  _lastBackupTime: 0,
  _interval: 10000,
  _backupInterval: 120000, // 2 minutes
  _maxTabsUndo: 5,
  _pendingWrite: 0,
  _pendingWritePrivateOnly: 0,
  _scrollSavePending: null,
  _formdataSavePending: null,
  _writeInProgress: false,

  // We only want to start doing backups if we've successfully
  // written the session data at least once.
  _sessionDataIsGood: false,

  // The index where the most recently closed tab was in the tabs array
  // when it was closed.
  _lastClosedTabIndex: INVALID_TAB_INDEX,

  // Whether or not to send notifications for changes to the closed tabs.
  _notifyClosedTabs: false,

  // If we're simultaneously closing both a tab and Firefox, we don't want
  // to bother reloading the newly selected tab if it is zombified.
  // The Java UI will tell us which tab to watch out for.
  _keepAsZombieTabId: INVALID_TAB_ID,

  init() {
    loggingEnabled = Services.prefs.getBoolPref(
      "browser.sessionstore.debug_logging"
    );

    // Get file references
    this._sessionFile = Services.dirsvc.get("ProfD", Ci.nsIFile);
    this._sessionFileBackup = this._sessionFile.clone();
    this._sessionFilePrevious = this._sessionFile.clone();
    this._sessionFileTemp = this._sessionFile.clone();
    this._sessionFile.append("sessionstore.js"); // The main session store save file.
    this._sessionFileBackup.append("sessionstore.bak"); // A backup copy to guard against interrupted writes.
    this._sessionFilePrevious.append("sessionstore.old"); // The previous session's file, used for what used to be the "Tabs from last time".
    this._sessionFileTemp.append(this._sessionFile.leafName + ".tmp"); // Temporary file for writing changes to disk.

    this._loadState = STATE_STOPPED;
    this._startupRestoreFinished = false;

    this._interval = Services.prefs.getIntPref("browser.sessionstore.interval");
    this._backupInterval = Services.prefs.getIntPref(
      "browser.sessionstore.backupInterval"
    );

    this._updateMaxTabsUndo();
    Services.prefs.addObserver(PREFS_MAX_TABS_UNDO, () => {
      this._updateMaxTabsUndo();
    });

    // Copy changes in Gecko settings to their Java counterparts,
    // so the startup code can access them
    SharedPreferences.forApp().setBoolPref(
      PREFS_RESTORE_FROM_CRASH,
      Services.prefs.getBoolPref(PREFS_RESTORE_FROM_CRASH)
    );
    SharedPreferences.forApp().setIntPref(
      PREFS_MAX_CRASH_RESUMES,
      Services.prefs.getIntPref(PREFS_MAX_CRASH_RESUMES)
    );
  },

  _updateMaxTabsUndo() {
    this._maxTabsUndo = Services.prefs.getIntPref(PREFS_MAX_TABS_UNDO);
    if (this._maxTabsUndo == 0) {
      this._forgetClosedTabs();
    }
  },

  _purgeHistory(topic) {
    log(topic);
    this._clearDisk();

    // Clear all data about closed tabs
    this._forgetClosedTabs();

    // Clear all cached session history data.
    if (topic == "browser:purge-session-history") {
      this._forEachBrowserWindow(window => {
        let tabs = window.BrowserApp.tabs;
        for (let i = 0; i < tabs.length; i++) {
          let data = tabs[i].browser.__SS_data;
          let sHistory = data.entries;
          // Copy the current history entry to the end...
          sHistory.push(sHistory[data.index - 1]);
          // ... and then remove everything else.
          sHistory.splice(0, sHistory.length - 1);
          data.index = 1;
        }
      });
    }

    if (this._loadState == STATE_RUNNING) {
      // Save the purged state immediately
      this.saveState();
    } else if (this._loadState <= STATE_QUITTING) {
      this.saveStateDelayed();
      if (this._loadState == STATE_QUITTING_FLUSHED) {
        this.flushPendingState();
      }
    }

    Services.obs.notifyObservers(null, "sessionstore-state-purge-complete");
    if (this._notifyClosedTabs) {
      this._sendClosedTabsToJava(
        Services.wm.getMostRecentWindow("navigator:browser")
      );
    }
  },

  _clearDisk() {
    this._sessionDataIsGood = false;
    this._lastBackupTime = 0;

    if (this._loadState > STATE_QUITTING) {
      OS.File.remove(this._sessionFile.path);
      OS.File.remove(this._sessionFileBackup.path);
      OS.File.remove(this._sessionFilePrevious.path);
      OS.File.remove(this._sessionFileTemp.path);
    } else {
      // We're shutting down and must delete synchronously
      if (this._sessionFile.exists()) {
        this._sessionFile.remove(false);
      }
      if (this._sessionFileBackup.exists()) {
        this._sessionFileBackup.remove(false);
      }
      if (this._sessionFilePrevious.exists()) {
        this._sessionFilePrevious.remove(false);
      }
      if (this._sessionFileTemp.exists()) {
        this._sessionFileTemp.remove(false);
      }
    }
  },

  _forgetClosedTabs() {
    for (let win of Object.values(this._windows)) {
      win.closedTabs = [];
    }

    this._lastClosedTabIndex = INVALID_TAB_INDEX;
  },

  onEvent(event, data, callback) {
    switch (event) {
      case "ClosedTabs:StartNotifications":
        this._notifyClosedTabs = true;
        log("ClosedTabs:StartNotifications");
        this._sendClosedTabsToJava(
          Services.wm.getMostRecentWindow("navigator:browser")
        );
        break;

      case "ClosedTabs:StopNotifications":
        this._notifyClosedTabs = false;
        log("ClosedTabs:StopNotifications");
        break;

      case "Session:FlushTabs":
        // We receive this notification when the activity or application is going into
        // the background. If the application is backgrounded, it may be terminated at
        // any point without notice; therefore, we must synchronously write out any
        // pending save state to ensure that this data does not get lost.
        log("Session:FlushTabs");
        if (!this._loadState == STATE_RUNNING || !this.flushPendingState()) {
          let window = Services.wm.getMostRecentWindow("navigator:browser");
          if (window) {
            // can be null if we're restarting
            window.WindowEventDispatcher.sendRequest({
              type: "PrivateBrowsing:Data",
              noChange: true,
            });
          }
        }
        break;

      case "Session:Restore": {
        EventDispatcher.instance.unregisterListener(this, "Session:Restore");
        if (data) {
          // Be ready to handle any restore failures by making sure we have a valid tab opened
          let window = Services.wm.getMostRecentWindow("navigator:browser");
          let restoreCleanup = (aSubject, aTopic, aData) => {
            Services.obs.removeObserver(
              restoreCleanup,
              "sessionstore-windows-restored"
            );

            if (window.BrowserApp.tabs.length == 0) {
              window.BrowserApp.addTab("about:home", {
                selected: true,
              });
            }
            // Normally, _restoreWindow() will have set this to true already,
            // but we want to make sure it's set even in case of a restore failure.
            this._startupRestoreFinished = true;
            log("startupRestoreFinished = true (through notification)");
          };
          Services.obs.addObserver(
            restoreCleanup,
            "sessionstore-windows-restored"
          );

          // Do a restore, triggered by Java
          this.restoreLastSession(data.sessionString);
        } else {
          // Not doing a restore; just send restore message
          this._startupRestoreFinished = true;
          log("startupRestoreFinished = true");
          Services.obs.notifyObservers(null, "sessionstore-windows-restored");
        }
        break;
      }

      case "Session:RestoreRecentTabs":
        this._restoreTabs(data);
        break;

      case "Tab:KeepZombified": {
        if (data.nextSelectedTabId >= 0) {
          this._keepAsZombieTabId = data.nextSelectedTabId;
          log("Tab:KeepZombified " + data.nextSelectedTabId);
        }
        break;
      }

      case "Tabs:OpenMultiple": {
        this._openTabs(data);

        if (data.shouldNotifyTabsOpenedToJava) {
          let window = Services.wm.getMostRecentWindow("navigator:browser");
          window.WindowEventDispatcher.sendRequest({
            type: "Tabs:TabsOpened",
          });
        }
        break;
      }
    }
  },

  observe(aSubject, aTopic, aData) {
    let observerService = Services.obs;
    switch (aTopic) {
      case "app-startup":
        EventDispatcher.instance.registerListener(this, [
          "ClosedTabs:StartNotifications",
          "ClosedTabs:StopNotifications",
          "Session:FlushTabs",
          "Session:Restore",
          "Session:RestoreRecentTabs",
          "Tab:KeepZombified",
          "Tabs:OpenMultiple",
        ]);
        observerService.addObserver(this, "final-ui-startup", true);
        observerService.addObserver(this, "domwindowopened", true);
        observerService.addObserver(this, "domwindowclosed", true);
        observerService.addObserver(
          this,
          "browser:purge-session-history",
          true
        );
        observerService.addObserver(this, "browser:purge-session-tabs", true);
        observerService.addObserver(this, "quit-application-requested", true);
        observerService.addObserver(this, "quit-application-proceeding", true);
        observerService.addObserver(this, "quit-application", true);
        observerService.addObserver(this, "Session:NotifyLocationChange", true);
        observerService.addObserver(this, "Content:HistoryChange", true);
        observerService.addObserver(this, "application-foreground", true);
        observerService.addObserver(this, "last-pb-context-exited", true);
        break;
      case "final-ui-startup":
        observerService.removeObserver(this, "final-ui-startup");
        this.init();
        break;
      case "domwindowopened": {
        let window = aSubject;
        window.addEventListener(
          "load",
          () => {
            this.onWindowOpen(window);
          },
          { once: true }
        );
        break;
      }
      case "domwindowclosed": // catch closed windows
        this.onWindowClose(aSubject);
        break;
      case "quit-application-requested":
        log("quit-application-requested");
        // Get a current snapshot of all windows
        if (this._pendingWrite) {
          this._forEachBrowserWindow(aWindow => {
            this._collectWindowData(aWindow);
          });
        }
        break;
      case "quit-application-proceeding":
        log("quit-application-proceeding");
        // Freeze the data at what we've got (ignoring closing windows)
        this._loadState = STATE_QUITTING;
        break;
      case "quit-application":
        log("quit-application");
        observerService.removeObserver(this, "domwindowopened");
        observerService.removeObserver(this, "domwindowclosed");
        observerService.removeObserver(this, "quit-application-requested");
        observerService.removeObserver(this, "quit-application-proceeding");
        observerService.removeObserver(this, "quit-application");

        // Flush all pending writes to disk now
        this.flushPendingState();
        this._loadState = STATE_QUITTING_FLUSHED;

        break;
      case "browser:purge-session-tabs":
      case "browser:purge-session-history": // catch sanitization
        this._purgeHistory(aTopic);
        break;
      case "timer-callback":
        if (this._loadState == STATE_RUNNING) {
          // Timer call back for delayed saving
          this._saveTimer = null;
          log(
            "timer-callback, pendingWrite = " +
              this._pendingWritePrivateOnly +
              "/" +
              this._pendingWrite
          );
          if (this._pendingWrite) {
            this._saveState(true);
          }
        }
        break;
      case "Session:NotifyLocationChange": {
        let browser = aSubject;

        if (browser.__SS_restoreReloadPending && this._startupRestoreFinished) {
          delete browser.__SS_restoreReloadPending;
          log("remove restoreReloadPending");
        }

        if (browser.__SS_restoreDataOnLocationChange) {
          delete browser.__SS_restoreDataOnLocationChange;
          this._restoreZoom(browser.__SS_data.scrolldata, browser);
        }
        break;
      }
      case "Content:HistoryChange": {
        let browser = aSubject;
        let window = browser.ownerGlobal;
        log(
          "Content:HistoryChange for tab " +
            window.BrowserApp.getTabForBrowser(browser).id
        );
        // We want to ignore history changes which we caused ourselves when
        // restoring the history of a delay-loaded tab.
        if (!browser.__SS_restore && !browser.__SS_restoreReloadPending) {
          // The OnHistory... notifications are called *before* the history changes
          // are persisted. We therefore need to make our onTabLoad call async,
          // so it can actually capture the new session history state.
          if (browser.__SS_historyChange) {
            window.clearTimeout(browser.__SS_historyChange);
          }
          browser.__SS_historyChange = window.setTimeout(() => {
            delete browser.__SS_historyChange;
            this.onTabLoad(window, browser);
          }, 0);
        }
        break;
      }
      case "application-foreground":
        log("application-foreground");
        // If we skipped restoring a zombified tab before backgrounding,
        // we might have to do it now instead.
        let window = Services.wm.getMostRecentWindow("navigator:browser");
        if (window && window.BrowserApp) {
          // Might not yet be ready during a cold startup.
          let tab = window.BrowserApp.selectedTab;
          if (tab) {
            // Can be null if closing a tab triggered an activity switch.
            this.restoreZombieTab(tab);
          }
        }
        break;
      case "last-pb-context-exited":
        // Clear private closed tab data when we leave private browsing.
        for (let window of Object.values(this._windows)) {
          window.closedTabs = window.closedTabs.filter(tab => !tab.isPrivate);
        }
        this._lastClosedTabIndex = INVALID_TAB_INDEX;
        break;
    }
  },

  handleEvent(aEvent) {
    let window = aEvent.currentTarget.ownerGlobal;
    switch (aEvent.type) {
      case "TabOpen": {
        let browser = aEvent.target;
        log(
          "TabOpen for tab " + window.BrowserApp.getTabForBrowser(browser).id
        );
        this.onTabAdd(window, browser);
        break;
      }
      case "TabClose": {
        let browser = aEvent.target;
        log(
          "TabClose for tab " + window.BrowserApp.getTabForBrowser(browser).id
        );
        this.onTabClose(window, browser, aEvent.detail);
        this.onTabRemove(window, browser);
        break;
      }
      case "TabPreZombify": {
        let browser = aEvent.target;
        log(
          "TabPreZombify for tab " +
            window.BrowserApp.getTabForBrowser(browser).id
        );
        this.onTabRemove(window, browser, true);
        break;
      }
      case "TabPostZombify": {
        let browser = aEvent.target;
        log(
          "TabPostZombify for tab " +
            window.BrowserApp.getTabForBrowser(browser).id
        );
        this.onTabAdd(window, browser, true);
        break;
      }
      case "TabSelect": {
        let browser = aEvent.target;
        log(
          "TabSelect for tab " + window.BrowserApp.getTabForBrowser(browser).id
        );
        this.onTabSelect(window, browser);
        break;
      }
      case "TabMove": {
        let browser = aEvent.target;
        log(
          "TabMove for tab " + window.BrowserApp.getTabForBrowser(browser).id
        );
        this.onTabMove();
        break;
      }
      case "DOMTitleChanged": {
        // Use DOMTitleChanged to detect page loads over alternatives.
        // onLocationChange happens too early, so we don't have the page title
        // yet; pageshow happens too late, so we could lose session data if the
        // browser were killed.
        let browser = aEvent.currentTarget;
        log(
          "DOMTitleChanged for tab " +
            window.BrowserApp.getTabForBrowser(browser).id
        );
        this.onTabLoad(window, browser);
        break;
      }
      case "load": {
        let browser = aEvent.currentTarget;

        // Skip subframe loads.
        if (browser.contentDocument !== aEvent.originalTarget) {
          return;
        }

        // Handle restoring the text data into the content and frames.
        // We wait until the main content and all frames are loaded
        // before trying to restore this data.
        log("load for tab " + window.BrowserApp.getTabForBrowser(browser).id);
        if (browser.__SS_restoreDataOnLoad) {
          delete browser.__SS_restoreDataOnLoad;
          this._restoreTextData(browser.__SS_data.formdata, browser);
        }
        break;
      }
      case "pageshow":
      case "AboutReaderContentReady": {
        let browser = aEvent.currentTarget;

        // Skip subframe pageshows.
        if (browser.contentDocument !== aEvent.originalTarget) {
          return;
        }

        if (
          browser.currentURI.spec.startsWith("about:reader") &&
          !browser.contentDocument.body.classList.contains("loaded")
        ) {
          // Don't restore the scroll position of an about:reader page at this point;
          // wait for the custom event dispatched from AboutReader.jsm instead.
          return;
        }

        // Restoring the scroll position needs to happen after the zoom level has been
        // restored, which is done by the MobileViewportManager either on first paint
        // or on load, whichever comes first.
        // In the latter case, our load handler runs before the MVM's one, which is the
        // wrong way around, so we have to use a later event instead.
        log(
          aEvent.type +
            " for tab " +
            window.BrowserApp.getTabForBrowser(browser).id
        );
        if (browser.__SS_restoreDataOnPageshow) {
          delete browser.__SS_restoreDataOnPageshow;
          this._restoreScrollPosition(browser.__SS_data.scrolldata, browser);
        } else {
          // We're not restoring, capture the initial scroll position on pageshow.
          this.onTabScroll(window, browser);
        }
        break;
      }
      case "input":
      case "DOMAutoComplete": {
        let browser = aEvent.currentTarget;
        // Duplicated logging check to avoid calling getTabForBrowser on each input event.
        if (loggingEnabled) {
          log(
            "TabInput for tab " + window.BrowserApp.getTabForBrowser(browser).id
          );
        }
        // Schedule saving instead of doing it immediately - immediate save will block activity, and in
        // cases like checking or unchecking 100 checkboxes, this can cause long delays. (bug 1443765)
        // XXX This may be better handled with idle detection similar to desktop (bug 1444222)
        if (!this._formdataSavePending) {
          this._formdataSavePending = window.setTimeout(() => {
            this._formdataSavePending = null;
            this.onTabInput(window, browser);
          }, 2000);
        }
        break;
      }
      case "mozvisualresize":
      case "mozvisualscroll": {
        let browser = aEvent.currentTarget;
        // Duplicated logging check to avoid calling getTabForBrowser on each scroll event.
        if (loggingEnabled) {
          log(
            aEvent.type +
              " for tab " +
              window.BrowserApp.getTabForBrowser(browser).id
          );
        }
        if (!this._scrollSavePending) {
          this._scrollSavePending = window.setTimeout(() => {
            this._scrollSavePending = null;
            this.onTabScroll(window, browser);
          }, 500);
        }
        break;
      }
    }
  },

  onWindowOpen(aWindow) {
    // Return if window has already been initialized
    if (aWindow && aWindow.__SSID && this._windows[aWindow.__SSID]) {
      return;
    }

    // Ignore non-browser windows and windows opened while shutting down
    if (
      aWindow.document.documentElement.getAttribute("windowtype") !=
        "navigator:browser" ||
      this._loadState <= STATE_QUITTING
    ) {
      return;
    }

    // Assign it a unique identifier (timestamp) and create its data object
    aWindow.__SSID = "window" + Date.now();
    this._windows[aWindow.__SSID] = {
      tabs: [],
      selectedTabId: INVALID_TAB_ID,
      closedTabs: [],
    };

    // Perform additional initialization when the first window is loading
    if (this._loadState == STATE_STOPPED) {
      this._loadState = STATE_RUNNING;
      this._lastSaveTime = Date.now();
    }

    // Add tab change listeners to all already existing tabs
    let tabs = aWindow.BrowserApp.tabs;
    for (let i = 0; i < tabs.length; i++) {
      this.onTabAdd(aWindow, tabs[i].browser, true);
    }

    // Notification of tab add/remove/selection/zombification
    let browsers = aWindow.document.getElementById("browsers");
    browsers.addEventListener("TabOpen", this, true);
    browsers.addEventListener("TabClose", this, true);
    browsers.addEventListener("TabSelect", this, true);
    browsers.addEventListener("TabMove", this, true);
    browsers.addEventListener("TabPreZombify", this, true);
    browsers.addEventListener("TabPostZombify", this, true);
  },

  onWindowClose(aWindow) {
    // Ignore windows not tracked by SessionStore
    if (!aWindow.__SSID || !this._windows[aWindow.__SSID]) {
      return;
    }

    let browsers = aWindow.document.getElementById("browsers");
    browsers.removeEventListener("TabOpen", this, true);
    browsers.removeEventListener("TabClose", this, true);
    browsers.removeEventListener("TabSelect", this, true);
    browsers.removeEventListener("TabMove", this, true);
    browsers.removeEventListener("TabPreZombify", this, true);
    browsers.removeEventListener("TabPostZombify", this, true);

    if (this._loadState == STATE_RUNNING) {
      // Update all window data for a last time
      this._collectWindowData(aWindow);

      // Clear this window from the list
      delete this._windows[aWindow.__SSID];

      // Save the state without this window to disk
      this.saveStateDelayed();
    }

    let tabs = aWindow.BrowserApp.tabs;
    for (let i = 0; i < tabs.length; i++) {
      this.onTabRemove(aWindow, tabs[i].browser, true);
    }

    delete aWindow.__SSID;
  },

  onTabAdd(aWindow, aBrowser, aNoNotification) {
    // Use DOMTitleChange to catch the initial load and restore history
    aBrowser.addEventListener("DOMTitleChanged", this, true);

    // Use load to restore text data
    aBrowser.addEventListener("load", this, true);

    // Gecko might set the initial zoom level after the JS "load" event,
    // so we have to restore zoom and scroll position after that.
    aBrowser.addEventListener("pageshow", this, true);
    aBrowser.addEventListener("AboutReaderContentReady", this, true);

    // Use a combination of events to watch for text data changes
    aBrowser.addEventListener("input", this, true);
    aBrowser.addEventListener("DOMAutoComplete", this, true);

    // Record the current scroll position and zoom level.
    aBrowser.addEventListener("mozvisualscroll", this, {
      capture: true,
      mozSystemGroup: true,
    });
    aBrowser.addEventListener("mozvisualresize", this, {
      capture: true,
      mozSystemGroup: true,
    });

    log(
      "onTabAdd() ran for tab " +
        aWindow.BrowserApp.getTabForBrowser(aBrowser).id +
        ", aNoNotification = " +
        aNoNotification
    );
    if (!aNoNotification) {
      if (this._loadState == STATE_QUITTING) {
        // A tab arrived just as were starting to shut down. Since we haven't yet received
        // application-quit, we refresh the window data one more time before the window closes.
        this._forEachBrowserWindow(aWindow => {
          this._collectWindowData(aWindow);
        });
      }
      this.saveStateDelayed();
    }
    this._updateCrashReportURL(aWindow);
  },

  onTabRemove(aWindow, aBrowser, aNoNotification) {
    // Cleanup event listeners
    aBrowser.removeEventListener("DOMTitleChanged", this, true);
    aBrowser.removeEventListener("load", this, true);
    aBrowser.removeEventListener("pageshow", this, true);
    aBrowser.removeEventListener("AboutReaderContentReady", this, true);
    aBrowser.removeEventListener("input", this, true);
    aBrowser.removeEventListener("DOMAutoComplete", this, true);
    aBrowser.removeEventListener("mozvisualscroll", this, {
      capture: true,
      mozSystemGroup: true,
    });
    aBrowser.removeEventListener("mozvisualresize", this, {
      capture: true,
      mozSystemGroup: true,
    });

    if (aBrowser.__SS_historyChange) {
      aWindow.clearTimeout(aBrowser.__SS_historyChange);
      delete aBrowser.__SS_historyChange;
    }

    delete aBrowser.__SS_data;

    log(
      "onTabRemove() ran for tab " +
        aWindow.BrowserApp.getTabForBrowser(aBrowser).id +
        ", aNoNotification = " +
        aNoNotification
    );
    if (!aNoNotification) {
      let isPrivate = PrivateBrowsingUtils.isBrowserPrivate(aBrowser);
      this.saveStateDelayed(isPrivate);
    }
  },

  onTabClose(aWindow, aBrowser, aTabIndex) {
    // collect any pending data before saving
    if (this._formdataSavePending) {
      this.onTabInput(aWindow, aBrowser);
    }
    if (this._scrollSavePending) {
      this.onTabScroll(aWindow, aBrowser);
    }
    let data = aBrowser.__SS_data;
    let tab = aWindow.BrowserApp.getTabForId(data.tabId);

    if (this._maxTabsUndo == 0 || this._sessionDataIsEmpty(data)) {
      this._lastClosedTabIndex = INVALID_TAB_INDEX;
      return;
    }

    if (aWindow.BrowserApp.tabs.length > 0) {
      // Bundle this browser's data and extra data and save in the closedTabs
      // window property
      data.extData = aBrowser.__SS_extdata || {};

      this._windows[aWindow.__SSID].closedTabs.unshift(data);
      let length = this._windows[aWindow.__SSID].closedTabs.length;
      if (length > this._maxTabsUndo) {
        this._windows[aWindow.__SSID].closedTabs.splice(
          this._maxTabsUndo,
          length - this._maxTabsUndo
        );
      }

      this._lastClosedTabIndex = aTabIndex;

      if (this._notifyClosedTabs) {
        this._sendClosedTabsToJava(aWindow);
      }

      log("onTabClose() ran for tab " + tab.id);
      sendEvent(aBrowser, "SSTabCloseProcessed");
    }
  },

  _sessionDataIsEmpty(aData) {
    if (!aData || !aData.entries || aData.entries.length == 0) {
      return true;
    }

    let entries = aData.entries;

    return (
      entries.length == 1 &&
      (entries[0].url == "about:home" ||
        entries[0].url == "about:privatebrowsing")
    );
  },

  onTabLoad(aWindow, aBrowser) {
    // If this browser belongs to a zombie tab or the initial restore hasn't yet finished,
    // skip any session save activity.
    if (
      aBrowser.__SS_restore ||
      !this._startupRestoreFinished ||
      aBrowser.__SS_restoreReloadPending
    ) {
      return;
    }

    // Ignore a transient "about:blank"
    if (!aBrowser.canGoBack && aBrowser.currentURI.spec == "about:blank") {
      return;
    }

    // Serialize the tab's session history data.
    let data = SessionHistory.collect(aBrowser.docShell);
    if (!data.index) {
      // Bail out if we couldn't collect even basic fallback data.
      return;
    }

    let formdata;
    let scrolldata;
    if (aBrowser.__SS_data) {
      formdata = aBrowser.__SS_data.formdata;
      scrolldata = aBrowser.__SS_data.scrolldata;
    }
    delete aBrowser.__SS_data;

    // Collect the rest of the tab data and merge it with the history collected above.
    this._collectTabData(aWindow, aBrowser, data);
    if (
      aBrowser.__SS_restoreDataOnLoad ||
      aBrowser.__SS_restoreDataOnPageshow
    ) {
      // If the tab has been freshly restored and the "load" or "pageshow"
      // events haven't yet fired, we need to preserve any form data and
      // scroll positions that might have been present.
      aBrowser.__SS_data.formdata = formdata;
      aBrowser.__SS_data.scrolldata = scrolldata;
    } else {
      // When navigating via the forward/back buttons, Gecko restores
      // the form data all by itself and doesn't invoke any input events.
      // As _collectTabData() doesn't save any form data, we need to manually
      // capture it to bridge the time until the next input event arrives.
      this.onTabInput(aWindow, aBrowser);
      // A similar thing applies for the scroll position, otherwise a stray
      // DOMTitleChanged event can clobber the scroll position if the user
      // doesn't scroll again afterwards.
      this.onTabScroll(aWindow, aBrowser);
    }

    log(
      "onTabLoad() ran for tab " +
        aWindow.BrowserApp.getTabForBrowser(aBrowser).id
    );
    sendEvent(aBrowser, "SSTabDataUpdated");
    this.saveStateDelayed();

    this._updateCrashReportURL(aWindow);
  },

  onTabSelect(aWindow, aBrowser) {
    if (this._loadState != STATE_RUNNING) {
      return;
    }

    let tab = aWindow.BrowserApp.getTabForBrowser(aBrowser);
    let tabId = tab.id;

    this._windows[aWindow.__SSID].selectedTabId = tabId;

    // Restore the resurrected browser
    if (tabId != this._keepAsZombieTabId) {
      this.restoreZombieTab(tab);
    } else {
      log("keeping as zombie tab " + tabId);
    }
    // The tab id passed through Tab:KeepZombified is valid for one TabSelect only.
    this._keepAsZombieTabId = INVALID_TAB_ID;

    log("onTabSelect() ran for tab " + tabId);
    this.saveStateDelayed();
    this._updateCrashReportURL(aWindow);

    // If the selected tab has changed while listening for closed tab
    // notifications, we may have switched between different private browsing
    // modes.
    if (this._notifyClosedTabs) {
      this._sendClosedTabsToJava(aWindow);
    }
  },

  restoreZombieTab(aTab) {
    if (!aTab.browser.__SS_restore) {
      return;
    }

    let browser = aTab.browser;
    let data = browser.__SS_data;
    this._restoreTab(data, browser);

    delete browser.__SS_restore;
    browser.removeAttribute("pending");
    log("restoring zombie tab " + aTab.id);
  },

  onTabMove() {
    if (this._loadState != STATE_RUNNING) {
      return;
    }

    // The long press that initiated the move canceled any close undo option that may have been
    // present.
    this._lastClosedTabIndex = INVALID_TAB_INDEX;
    this.saveStateDelayed();
  },

  onTabInput(aWindow, aBrowser) {
    // If we've been called directly, cancel any pending timeouts.
    if (this._formdataSavePending) {
      aWindow.clearTimeout(this._formdataSavePending);
      this._formdataSavePending = null;
      log("onTabInput() clearing pending timeout");
    }

    // If this browser belongs to a zombie tab or the initial restore hasn't yet finished,
    // skip any session save activity.
    if (
      aBrowser.__SS_restore ||
      !this._startupRestoreFinished ||
      aBrowser.__SS_restoreReloadPending
    ) {
      sendEvent(aBrowser, "SSTabInputCaptured");
      return;
    }

    // Don't bother trying to save text data if we don't have history yet
    let data = aBrowser.__SS_data;
    if (!data || data.entries.length == 0) {
      sendEvent(aBrowser, "SSTabInputCaptured");
      return;
    }

    // Store the form data.
    let content = aBrowser.contentWindow;
    let formdata = SessionStoreUtils.collectFormData(content);
    formdata = PrivacyFilter.filterFormData(formdata || {});

    // If we found any form data, main content or frames, let's save it
    if (formdata && Object.keys(formdata).length) {
      data.formdata = formdata;
      log(
        "onTabInput() ran for tab " +
          aWindow.BrowserApp.getTabForBrowser(aBrowser).id
      );
      this.saveStateDelayed();
    }
    sendEvent(aBrowser, "SSTabInputCaptured");
  },

  onTabScroll(aWindow, aBrowser) {
    // If we've been called directly, cancel any pending timeouts.
    if (this._scrollSavePending) {
      aWindow.clearTimeout(this._scrollSavePending);
      this._scrollSavePending = null;
      log("onTabScroll() clearing pending timeout");
    }

    // If this browser belongs to a zombie tab or the initial restore hasn't yet finished,
    // skip any session save activity.
    if (
      aBrowser.__SS_restore ||
      !this._startupRestoreFinished ||
      aBrowser.__SS_restoreReloadPending
    ) {
      return;
    }

    // Don't bother trying to save scroll positions if we don't have history yet.
    let data = aBrowser.__SS_data;
    if (!data || data.entries.length == 0) {
      return;
    }

    // Neither bother if we're yet to restore the previous scroll position.
    if (
      aBrowser.__SS_restoreDataOnLoad ||
      aBrowser.__SS_restoreDataOnPageshow
    ) {
      return;
    }

    // Save the scroll position itself.
    let content = aBrowser.contentWindow;
    let scrolldata = SessionStoreUtils.collectScrollPosition(content);
    scrolldata = scrolldata || {};

    // Save the current document resolution.
    let zoom = 1;
    zoom = content.windowUtils.getResolution();
    scrolldata.zoom = {};
    scrolldata.zoom.resolution = zoom;
    log("onTabScroll() zoom level: " + zoom);

    // Save some data that'll help in adjusting the zoom level
    // when restoring in a different screen orientation.
    scrolldata.zoom.displaySize = this._getContentViewerSize(content);
    log("onTabScroll() displayWidth: " + scrolldata.zoom.displaySize.width);

    // Save zoom and scroll data.
    data.scrolldata = scrolldata;
    log(
      "onTabScroll() ran for tab " +
        aWindow.BrowserApp.getTabForBrowser(aBrowser).id
    );
    sendEvent(aBrowser, "SSTabScrollCaptured");
    this.saveStateDelayed();
  },

  _getContentViewerSize(aWindow) {
    let displaySize = {};
    let width = {},
      height = {};
    aWindow.windowUtils.getContentViewerSize(width, height);

    displaySize.width = width.value;
    displaySize.height = height.value;

    return displaySize;
  },

  saveStateDelayed(aPrivateTabsOnly = false) {
    this._pendingWrite++;
    if (aPrivateTabsOnly) {
      this._pendingWritePrivateOnly++;
    }
    log(
      "incrementing _pendingWrite to " +
        this._pendingWritePrivateOnly +
        "/" +
        this._pendingWrite
    );

    if (!this._saveTimer) {
      // Interval until the next disk operation is allowed
      let currentDelay = this._lastSaveTime + this._interval - Date.now();

      // If we have to wait, set a timer, otherwise saveState directly
      let delay = aPrivateTabsOnly
        ? SAVE_INTERVAL_PRIVATE_TABS
        : Math.max(currentDelay, MINIMUM_SAVE_DELAY);
      if (delay > 0) {
        this._createTimer(delay);
      } else {
        log("saveStateDelayed() no delay");
        this.saveState();
      }
    } else if (
      aPrivateTabsOnly &&
      // How long until the current timer would fire?
      this._saveTimer.delay - (Date.now() - this._lastQueuedSaveTime) >
        SAVE_INTERVAL_PRIVATE_TABS
    ) {
      this._killTimer();
      this._createTimer(SAVE_INTERVAL_PRIVATE_TABS);
    } else {
      log("saveStateDelayed() timer already running, taking no action");
    }
  },

  saveState(aPrivateTabsOnly = false) {
    this._pendingWrite++;
    if (aPrivateTabsOnly) {
      this._pendingWritePrivateOnly++;
    }
    log(
      "saveState(), incrementing _pendingWrite to " +
        this._pendingWritePrivateOnly +
        "/" +
        this._pendingWrite
    );
    this._saveState(true);
  },

  /**
   * Immediately and synchronously writes any pending state to disk.
   *
   * @return True if data was written, false if no pending file writes were present.
   */
  flushPendingState() {
    log("flushPendingState(), _pendingWrite = " + this._pendingWrite);
    if (this._pendingWrite) {
      this._saveState(false);
      return true;
    }
    return false;
  },

  _createTimer(aDelay) {
    this._lastQueuedSaveTime = Date.now();
    this._saveTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._saveTimer.init(this, aDelay, Ci.nsITimer.TYPE_ONE_SHOT);
    log("saveTimer delay = " + aDelay);
  },

  _killTimer() {
    if (this._saveTimer) {
      this._saveTimer.cancel();
      this._saveTimer = null;
      log("killed queued saveTimer");
    }
  },

  _saveState(aAsync) {
    log("_saveState(aAsync = " + aAsync + ")");
    // Kill any queued timer and save immediately
    this._killTimer();

    // Periodically save a "known good" copy of the session store data.
    if (
      !this._writeInProgress &&
      Date.now() - this._lastBackupTime > this._backupInterval &&
      this._sessionDataIsGood &&
      this._sessionFile.exists()
    ) {
      if (this._sessionFileBackup.exists()) {
        this._sessionFileBackup.remove(false);
      }

      log("_saveState() backing up session data");
      this._sessionFile.copyTo(null, this._sessionFileBackup.leafName);
      this._lastBackupTime = Date.now();
    }

    let data = this._getCurrentState();
    let normalData = { windows: [] };
    let privateData = { windows: [] };
    log("_saveState() current state collected");

    for (let winIndex = 0; winIndex < data.windows.length; ++winIndex) {
      let win = data.windows[winIndex];
      let normalWin = {};
      for (let prop in win) {
        normalWin[prop] = data[prop];
      }
      // This particular attribute will be converted to a tab index further down
      // and stored in the appropriate (normal or private) window data.
      delete normalWin.selectedTabId;
      normalWin.tabs = [];

      // Save normal closed tabs. Forget about private closed tabs.
      normalWin.closedTabs = win.closedTabs.filter(tab => !tab.isPrivate);

      normalData.windows.push(normalWin);
      privateData.windows.push({ tabs: [] });

      // Split the session data into private and non-private data objects.
      // Non-private session data will be saved to disk, and private session
      // data will be sent to Java for Android to hold it in memory.
      for (let i = 0; i < win.tabs.length; ++i) {
        let tab = win.tabs[i];
        let savedWin = tab.isPrivate
          ? privateData.windows[winIndex]
          : normalData.windows[winIndex];
        savedWin.tabs.push(tab);
        if (win.selectedTabId === tab.tabId) {
          savedWin.selected = savedWin.tabs.length; // 1-based index
        }
      }
    }

    // If we have private data, send it to Java; otherwise, send null to
    // indicate that there is no private data
    let window = Services.wm.getMostRecentWindow("navigator:browser");
    if (window) {
      // can be null if we're restarting
      window.WindowEventDispatcher.sendRequest({
        type: "PrivateBrowsing:Data",
        session:
          privateData.windows.length > 0 &&
          privateData.windows[0].tabs.length > 0
            ? JSON.stringify(privateData)
            : null,
      });
    }

    // If all queued writes were for private tabs only, we can stop here.
    if (this._pendingWrite === this._pendingWritePrivateOnly) {
      this._pendingWrite = 0;
      this._pendingWritePrivateOnly = 0;
      this._lastSaveTime = Date.now();
      return;
    }

    // Write only non-private data to disk
    if (normalData.windows[0] && normalData.windows[0].tabs) {
      log(
        "_saveState() writing normal data, " +
          normalData.windows[0].tabs.length +
          " tabs in window[0]"
      );
    } else {
      log("_saveState() writing empty normal data");
    }
    this._writeFile(
      this._sessionFile,
      this._sessionFileTemp,
      normalData,
      aAsync
    );

    this._lastSaveTime = Date.now();
  },

  _getCurrentState() {
    this._forEachBrowserWindow(aWindow => {
      this._collectWindowData(aWindow);
    });

    let data = { windows: [] };
    for (let index in this._windows) {
      data.windows.push(this._windows[index]);
    }

    return data;
  },

  _collectTabData(aWindow, aBrowser, aHistory) {
    // If this browser is being restored, skip any session save activity
    if (aBrowser.__SS_restore) {
      return;
    }

    let tabData = {};
    let tab = aWindow.BrowserApp.getTabForBrowser(aBrowser);
    tabData.entries = aHistory.entries;
    tabData.index = aHistory.index;
    tabData.attributes = { image: aBrowser.mIconURL };
    tabData.desktopMode = tab.desktopMode;
    tabData.isPrivate = PrivateBrowsingUtils.isBrowserPrivate(aBrowser);
    tabData.tabId = tab.id;
    tabData.parentId = tab.parentId;

    aBrowser.__SS_data = tabData;
  },

  _collectWindowData(aWindow) {
    // Ignore windows not tracked by SessionStore
    if (!aWindow.__SSID || !this._windows[aWindow.__SSID]) {
      return;
    }

    let winData = this._windows[aWindow.__SSID];
    winData.tabs = [];

    let selectedTab = aWindow.BrowserApp.selectedTab;

    if (selectedTab != null) {
      winData.selectedTabId = selectedTab.id;
    }

    let tabs = aWindow.BrowserApp.tabs;
    for (let i = 0; i < tabs.length; i++) {
      let browser = tabs[i].browser;
      if (browser.__SS_data) {
        let tabData = browser.__SS_data;
        if (browser.__SS_extdata) {
          tabData.extData = browser.__SS_extdata;
        }
        winData.tabs.push(tabData);
      }
    }
  },

  _forEachBrowserWindow(aFunc) {
    for (let window of Services.wm.getEnumerator("navigator:browser")) {
      if (window.__SSID && !window.closed) {
        aFunc.call(this, window);
      }
    }
  },

  /**
   * Writes the session state to a disk file, while doing some telemetry and notification
   * bookkeeping.
   * @param aFile nsIFile used for saving the session
   * @param aFileTemp nsIFile used as a temporary file in writing the data
   * @param aData JSON session state
   * @param aAsync boolelan used to determine the method of saving the state
   */
  _writeFile(aFile, aFileTemp, aData, aAsync) {
    TelemetryStopwatch.start("FX_SESSION_RESTORE_SERIALIZE_DATA_MS");
    let state = JSON.stringify(aData);
    TelemetryStopwatch.finish("FX_SESSION_RESTORE_SERIALIZE_DATA_MS");

    // Convert data string to a utf-8 encoded array buffer
    let buffer = new TextEncoder().encode(state);
    Services.telemetry
      .getHistogramById("FX_SESSION_RESTORE_FILE_SIZE_BYTES")
      .add(buffer.byteLength);

    Services.obs.notifyObservers(null, "sessionstore-state-write");
    let startWriteMs = Cu.now();

    log(
      "_writeFile(aAsync = " +
        aAsync +
        "), _pendingWrite = " +
        this._pendingWrite
    );
    this._writeInProgress = true;
    let pendingWrite = this._pendingWrite;
    this._write(aFile, aFileTemp, buffer, aAsync).then(() => {
      let stopWriteMs = Cu.now();

      // Make sure this._pendingWrite is the same value it was before we
      // fired off the async write. If the count is different, another write
      // is pending, so we shouldn't reset this._pendingWrite yet.
      if (pendingWrite === this._pendingWrite) {
        this._pendingWrite = 0;
        this._pendingWritePrivateOnly = 0;
        this._writeInProgress = false;
      }

      log(
        "_writeFile() _write() returned, _pendingWrite = " + this._pendingWrite
      );

      // We don't use a stopwatch here since the calls are async and stopwatches can only manage
      // a single timer per histogram.
      Services.telemetry
        .getHistogramById("FX_SESSION_RESTORE_WRITE_FILE_MS")
        .add(Math.round(stopWriteMs - startWriteMs));
      Services.obs.notifyObservers(null, "sessionstore-state-write-complete");
      EventDispatcher.instance.sendRequest({ type: "Session:DataWritten" });
      this._sessionDataIsGood = true;
    });
  },

  /**
   * Writes the session state to a disk file, using async or sync methods
   * @param aFile nsIFile used for saving the session
   * @param aFileTemp nsIFile used as a temporary file in writing the data
   * @param aBuffer UTF-8 encoded ArrayBuffer of the session state
   * @param aAsync boolelan used to determine the method of saving the state
   * @return Promise that resolves when the file has been written
   */
  _write(aFile, aFileTemp, aBuffer, aAsync) {
    // Use async file writer and just return it's promise
    if (aAsync) {
      log("_write() writing asynchronously");
      return OS.File.writeAtomic(aFile.path, aBuffer, {
        tmpPath: aFileTemp.path,
      });
    }

    // Convert buffer to an encoded string and sync write to disk
    let bytes = String.fromCharCode.apply(null, new Uint16Array(aBuffer));
    let stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
      Ci.nsIFileOutputStream
    );
    stream.init(aFileTemp, 0x02 | 0x08 | 0x20, 0o666, 0);
    stream.write(bytes, bytes.length);
    stream.close();
    // Mimic writeAtomic behaviour when tmpPath is set and write
    // to a temp file which is then renamed at the end.
    aFileTemp.renameTo(null, aFile.leafName);
    log("_write() writing synchronously");

    // Return a resolved promise to make the caller happy
    return Promise.resolve();
  },

  _updateCrashReportURL(aWindow) {
    if (!AppConstants.MOZ_CRASHREPORTER) {
      return;
    }

    if (!aWindow.BrowserApp.selectedBrowser) {
      return;
    }

    try {
      let currentURI = aWindow.BrowserApp.selectedBrowser.currentURI;
      // if the current URI contains a username/password, remove it
      try {
        currentURI = currentURI
          .mutate()
          .setUserPass("")
          .finalize();
      } catch (ex) {} // ignore failures on about: URIs

      Services.appinfo.annotateCrashReport("URL", currentURI.spec);
    } catch (ex) {
      // don't make noise when crashreporter is built but not enabled
      if (ex.result != Cr.NS_ERROR_NOT_INITIALIZED) {
        Cu.reportError("SessionStore:" + ex);
      }
    }
  },

  // This function iterates through a list of urls opening a new tab for each.
  _openTabs(aData) {
    let window = Services.wm.getMostRecentWindow("navigator:browser");
    for (let i = 0; i < aData.urls.length; i++) {
      let url = aData.urls[i];
      let selected = i == aData.urls.length - 1;
      let params = {
        selected,
        delayLoad: !selected,
        isPrivate: false,
        desktopMode: false,
      };

      window.BrowserApp.addTab(url, params);
    }
  },

  // This function iterates through a list of tab data restoring session for each of them.
  _restoreTabs(aData) {
    let window = Services.wm.getMostRecentWindow("navigator:browser");
    let tabIds = [];
    for (let i = 0; i < aData.tabs.length; i++) {
      let tabData = JSON.parse(aData.tabs[i]);
      let activeSHEntry = tabData.entries[tabData.index - 1];
      let selected = i == aData.tabs.length - 1;
      let delayLoad = !selected;
      if (tabData.tabId) {
        tabIds.push(tabData.tabId);
      }

      let params = {
        title: activeSHEntry.title,
        selected,
        delayLoad,
        isPrivate: tabData.isPrivate,
        desktopMode: tabData.desktopMode,
        cancelEditMode: selected,
        parentId: tabData.parentId,
      };

      let tab = window.BrowserApp.addTab(activeSHEntry.url, params);
      tab.browser.__SS_data = tabData;
      tab.browser.__SS_extdata = tabData.extData;
      if (!delayLoad) {
        this._restoreTab(tabData, tab.browser);
      }
    }
    this._removeClosedTabs(window, tabIds);
  },

  /**
   * Starts the restoration process for a browser. History is restored at this
   * point, but text data must be delayed until the content loads.
   */
  _restoreTab(aTabData, aBrowser) {
    // aTabData shouldn't be empty here, but if it is,
    // _restoreHistory() will crash otherwise.
    if (!aTabData || aTabData.entries.length == 0) {
      Cu.reportError(
        "SessionStore.js: Error trying to restore tab with empty tabdata"
      );
      return;
    }
    this._restoreHistory(aBrowser.docShell, aTabData);

    // Various bits of state can only be restored if page loading has progressed far enough:
    // The MobileViewportManager needs to be told as early as possible about
    // our desired zoom level so it can take it into account during the
    // initial document resolution calculation.
    aBrowser.__SS_restoreDataOnLocationChange = true;
    // Restoring saved form data requires the input fields to be available,
    // so we have to wait for the content to load.
    aBrowser.__SS_restoreDataOnLoad = true;
    // Restoring the scroll position depends on the document resolution having been set,
    // which is only guaranteed to have happened *after* we receive the load event.
    aBrowser.__SS_restoreDataOnPageshow = true;
  },

  /**
   * A thin wrapper around SessionHistory.jsm's restore function, which
   * takes serialized history data and restores it into the given
   * nsISessionHistory object.
   */
  _restoreHistory(aDocShell, aTabData) {
    let history = SessionHistory.restore(aDocShell, aTabData);

    // SessionHistory.jsm will have force set the active history item,
    // but we still need to reload it in order to finish the process.
    try {
      history.QueryInterface(Ci.nsISHistory).reloadCurrentEntry();
    } catch (e) {
      // This will throw if the current entry is an error page.
    }
  },

  /**
   * Takes serialized form text data and restores it into the given browser.
   */
  _restoreTextData(aFormData, aBrowser) {
    if (aFormData) {
      log("_restoreTextData()");
      Utils.restoreFrameTreeData(
        aBrowser.contentWindow,
        aFormData,
        (frame, data) => {
          // restore() will return false, and thus abort restoration for the
          // current |frame| and its descendants, if |data.url| is given but
          // doesn't match the loaded document's URL.
          return SessionStoreUtils.restoreFormData(frame.document, data);
        }
      );
    }
  },

  /**
   * Restores the zoom level of the window. This needs to be called before
   * first paint/load (whichever comes first) to take any effect.
   */
  _restoreZoom(aScrollData, aBrowser) {
    if (aScrollData && aScrollData.zoom && aScrollData.zoom.displaySize) {
      log(
        "_restoreZoom(), resolution: " +
          aScrollData.zoom.resolution +
          ", old displayWidth: " +
          aScrollData.zoom.displaySize.width
      );

      let utils = aBrowser.contentWindow.windowUtils;
      // Restore zoom level.
      utils.setRestoreResolution(
        aScrollData.zoom.resolution,
        aScrollData.zoom.displaySize.width,
        aScrollData.zoom.displaySize.height
      );
    }
  },

  /**
   * Takes serialized scroll positions and restores them into the given browser.
   */
  _restoreScrollPosition(aScrollData, aBrowser) {
    if (aScrollData) {
      log("_restoreScrollPosition()");
      Utils.restoreFrameTreeData(
        aBrowser.contentWindow,
        aScrollData,
        (frame, data) => {
          if (data.scroll) {
            SessionStoreUtils.restoreScrollPosition(frame, data);
          }
        }
      );
    }
  },

  getBrowserState() {
    return this._getCurrentState();
  },

  _restoreWindow(aData) {
    let state;
    try {
      state = JSON.parse(aData);
    } catch (e) {
      throw new Error("Invalid session JSON: " + aData);
    }

    // To do a restore, we must have at least one window with one tab
    if (
      !state ||
      state.windows.length == 0 ||
      !state.windows[0].tabs ||
      state.windows[0].tabs.length == 0
    ) {
      throw new Error("Invalid session JSON: " + aData);
    }

    let window = Services.wm.getMostRecentWindow("navigator:browser");
    let tabs = state.windows[0].tabs;

    for (let i = 0; i < tabs.length; i++) {
      let tabData = tabs[i];

      // Get the stubbed tab
      let tab = window.BrowserApp.getTabForId(tabData.tabId);

      // Don't restore tab if user has already closed it
      if (tab == null) {
        delete tabData.tabId;
        continue;
      }

      let parentId = tabData.parentId;
      if (parentId > INVALID_TAB_ID) {
        tab.parentId = parentId;
      }

      tab.browser.__SS_data = tabData;
      tab.browser.__SS_extdata = tabData.extData;

      if (window.BrowserApp.selectedTab == tab) {
        // After we're done restoring, we can lift the general ban on tab data
        // capturing, but we still need to protect the foreground tab until we're
        // sure it's actually reloading after history restoring has finished.
        tab.browser.__SS_restoreReloadPending = true;

        this._restoreTab(tabData, tab.browser);
        this._startupRestoreFinished = true;
        log("startupRestoreFinished = true");

        delete tab.browser.__SS_restore;
        tab.browser.removeAttribute("pending");

        this._windows[window.__SSID].selectedTabId = tab.id;
      } else {
        // Mark the browser for delay loading
        tab.browser.__SS_restore = true;
        tab.browser.setAttribute("pending", "true");
      }
    }

    // Restore the closed tabs array on the current window.
    if (state.windows[0].closedTabs && this._maxTabsUndo > 0) {
      this._windows[window.__SSID].closedTabs = state.windows[0].closedTabs;
      log(
        "_restoreWindow() loaded " +
          state.windows[0].closedTabs.length +
          " closed tabs"
      );
    }
  },

  getClosedTabCount(aWindow) {
    if (!aWindow || !aWindow.__SSID || !this._windows[aWindow.__SSID]) {
      return 0; // not a browser window, or not otherwise tracked by SS.
    }

    return this._windows[aWindow.__SSID].closedTabs.length;
  },

  getClosedTabs(aWindow) {
    if (!aWindow.__SSID) {
      throw new Error((Components.returnCode = Cr.NS_ERROR_INVALID_ARG));
    }

    return this._windows[aWindow.__SSID].closedTabs;
  },

  undoCloseTab(aWindow, aCloseTabData) {
    if (!aWindow.__SSID) {
      throw new Error((Components.returnCode = Cr.NS_ERROR_INVALID_ARG));
    }

    // If the tab data is in the closedTabs array, remove it.
    if (aCloseTabData.tabId) {
      let tabId = [aCloseTabData.tabId];
      this._removeClosedTabs(aWindow, tabId);
    }

    // create a new tab and bring to front
    let params = {
      selected: true,
      isPrivate: aCloseTabData.isPrivate,
      desktopMode: aCloseTabData.desktopMode,
      tabIndex: this._lastClosedTabIndex,
      parentId: aCloseTabData.parentId,
    };
    let tab = aWindow.BrowserApp.addTab(
      aCloseTabData.entries[aCloseTabData.index - 1].url,
      params
    );
    tab.browser.__SS_data = aCloseTabData;
    tab.browser.__SS_extdata = aCloseTabData.extData;
    this._restoreTab(aCloseTabData, tab.browser);

    this._lastClosedTabIndex = INVALID_TAB_INDEX;

    return tab.browser;
  },

  _removeClosedTabs(aWindow, aTabIds) {
    if (!aTabIds || aTabIds.length == 0) {
      return;
    }

    if (!aWindow || !aWindow.__SSID) {
      return;
    }

    const window = this._windows[aWindow.__SSID];
    let closedTabs = window.closedTabs;
    if (!closedTabs) {
      return;
    }
    const prevClosedTabCount = closedTabs.length;

    closedTabs = closedTabs.filter(
      closedTab => !closedTab.tabId || !aTabIds.includes(closedTab.tabId)
    );
    window.closedTabs = closedTabs;

    if (this._notifyClosedTabs && closedTabs.length != prevClosedTabCount) {
      this._sendClosedTabsToJava(aWindow);
    }
  },

  get canUndoLastCloseTab() {
    return this._lastClosedTabIndex > INVALID_TAB_INDEX;
  },

  _sendClosedTabsToJava(aWindow) {
    // If the app is shutting down, we don't need to do anything.
    if (this._loadState <= STATE_QUITTING) {
      return;
    }

    if (!aWindow.__SSID) {
      throw new Error((Components.returnCode = Cr.NS_ERROR_INVALID_ARG));
    }

    let closedTabs = this._windows[aWindow.__SSID].closedTabs;
    let isPrivate = PrivateBrowsingUtils.isBrowserPrivate(
      aWindow.BrowserApp.selectedBrowser
    );

    let tabs = closedTabs
      .filter(tab => tab.isPrivate == isPrivate)
      .map(function(tab) {
        // Get the url and title for the current entry in the session history.
        let entry = tab.entries[tab.index - 1];
        return {
          url: entry.url,
          title: entry.title || "",
          data: JSON.stringify(tab),
        };
      });

    log("sending " + tabs.length + " closed tabs to Java");
    EventDispatcher.instance.sendRequest({
      type: "ClosedTabs:Data",
      tabs: tabs,
    });
  },

  getTabValue(aTab, aKey) {
    let browser = aTab.browser;
    let data = browser.__SS_extdata || {};
    return data[aKey] || "";
  },

  setTabValue(aTab, aKey, aStringValue) {
    let browser = aTab.browser;
    if (!browser.__SS_extdata) {
      browser.__SS_extdata = {};
    }
    browser.__SS_extdata[aKey] = aStringValue;
    this.saveStateDelayed();
  },

  deleteTabValue(aTab, aKey) {
    let browser = aTab.browser;
    if (browser.__SS_extdata && aKey in browser.__SS_extdata) {
      delete browser.__SS_extdata[aKey];
      this.saveStateDelayed();
    }
  },

  restoreLastSession(aSessionString) {
    let notifyMessage = "";

    try {
      this._restoreWindow(aSessionString);
    } catch (e) {
      Cu.reportError("SessionStore: " + e);
      notifyMessage = "fail";
    }

    Services.obs.notifyObservers(
      null,
      "sessionstore-windows-restored",
      notifyMessage
    );
  },

  removeWindow(aWindow) {
    if (!aWindow || !aWindow.__SSID || !this._windows[aWindow.__SSID]) {
      return;
    }

    delete this._windows[aWindow.__SSID];
    delete aWindow.__SSID;

    if (this._loadState == STATE_RUNNING) {
      // Save the purged state immediately
      this.saveState();
    } else if (this._loadState <= STATE_QUITTING) {
      this.saveStateDelayed();
    }
  },

  setLoadState(aState) {
    this.flushPendingState();
    this._loadState = aState;
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SessionStore]);
