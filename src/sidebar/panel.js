/* exported TEXT_ALIGN_DIR */
const UI_LANG = browser.i18n.getUILanguage();
const RTL_LANGS = ['ar', 'fa', 'he'];
const LANG_DIR = RTL_LANGS.includes(UI_LANG) ? 'rtl' : 'ltr';
const TEXT_ALIGN_DIR = LANG_DIR === 'rtl' ? 'right' : 'left';
const SURVEY_PATH = 'https://qsurvey.mozilla.com/s3/notes?ref=sidebar';

const footerButtons = document.getElementById('footer-buttons');
const enableSync = document.getElementById('enable-sync');
const giveFeedbackButton = document.getElementById('give-feedback-button');
const giveFeedbackMenuItem = document.getElementById('give-feedback');
const savingIndicator = document.getElementById('saving-indicator');
savingIndicator.textContent = browser.i18n.getMessage('changesSaved');

const disconnectSync = document.getElementById('disconnect-from-sync');
disconnectSync.style.display = 'none';
disconnectSync.textContent = browser.i18n.getMessage('disableSync');

const INITIAL_CONTENT = `<h2>${browser.i18n.getMessage('welcomeTitle3')}</h2><p>${browser.i18n.getMessage('welcomeSubtitle')}</p><p><strong>${browser.i18n.getMessage('welcomeOpenNotes')}</strong></p><ul><li>${browser.i18n.getMessage('welcomeWindowsLinuxShortcut', '<code>Alt+Shift+W</code>')}</li><li>${browser.i18n.getMessage('welcomeMacShortcut', '<code>Opt+Shift+W</code>')}</li></ul><p><strong>${browser.i18n.getMessage('welcomeAccessNotes')}</strong></p><ul><li>${browser.i18n.getMessage('welcomeSyncInfo', '<strong>' + browser.i18n.getMessage('syncNotes') + '</strong>')}</li></ul><p>${browser.i18n.getMessage('welcomeFormatText')}</p><ul><li>${browser.i18n.getMessage('welcomeHeading').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeBold').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeItalics').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeBulleted').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeNumbered').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeCode').replace(/ ``/g, ' <code>`').replace(/``/g, '`</code>')}</li></ul><p><strong>${browser.i18n.getMessage('welcomeSuggestion')}</strong></p><ul><li>${browser.i18n.getMessage('welcomeGiveFeedback', '<strong>' + browser.i18n.getMessage('feedback') + '</strong>' )}</li></ul><p>${browser.i18n.getMessage('welcomeThatsIt')}</p>`;

let isAuthenticated = false;
let waitingToReconnect = false;
let loginTimeout;
let editingInProcess = false;
let syncingInProcess = false;

enableSync.setAttribute('title', browser.i18n.getMessage('syncNotes'));
giveFeedbackButton.setAttribute('title', browser.i18n.getMessage('feedback'));
giveFeedbackMenuItem.text = browser.i18n.getMessage('feedback');

function giveFeedbackCallback(e) {
  e.preventDefault();
  browser.tabs.create({
    url: SURVEY_PATH
  });
}

giveFeedbackButton.addEventListener('dragstart', (e) => {
  e.preventDefault();
});

giveFeedbackMenuItem.addEventListener('dragstart', (e) => {
  e.preventDefault();
});

giveFeedbackButton.addEventListener('click', giveFeedbackCallback);
giveFeedbackMenuItem.addEventListener('click', giveFeedbackCallback);

// ignoreNextLoadEvent is used to make sure the update does not trigger on other sidebars
let ignoreNextLoadEvent = false;
let ignoreTextSynced = false;
let lastModified;

ClassicEditor.create(document.querySelector('#editor'), {
  heading: {
    options: [
      { modelElement: 'heading1', viewElement: 'h1', title: browser.i18n.getMessage('title1'), class: 'ck-heading_heading1' },
      { modelElement: 'heading2', viewElement: 'h2', title: browser.i18n.getMessage('title2'), class: 'ck-heading_heading2' },
      { modelElement: 'heading3', viewElement: 'h3', title: browser.i18n.getMessage('title3'), class: 'ck-heading_heading3' },
      { modelElement: 'paragraph', title: browser.i18n.getMessage('bodyText'), class: 'ck-heading_paragraph' }
    ]
  },
  toolbar: ['headings', 'bold', 'italic', 'strike', 'bulletedList', 'numberedList'],
}).then(editor => {
  return migrationCheck(editor)
    .then(() => {
      editor.document.on('change', (eventInfo, name) => {
        const isFocused = document.querySelector('.ck-editor__editable').classList.contains('ck-focused');
        // Only use the focused editor or handle 'rename' events to set the data into storage.
        if (isFocused || name === 'rename' || name === 'insert') {
          const content = editor.getData();
          if (!ignoreNextLoadEvent && content !== undefined &&
              content.replace(/&nbsp;/g, ' ') !== INITIAL_CONTENT.replace(/\s\s+/g, ' ')) {
            ignoreTextSynced = true;
            if (content.length > 15000) {
              console.error('Maximum notepad size reached:', content.length); // eslint-disable-line no-console
              migrationNote.classList.add('visible');
              migrationBody.textContent = browser.i18n.getMessage('maximumPadSizeExceeded');
              browser.runtime.sendMessage({
                action: 'metrics-limit-reached',
                context: getPadStats(editor)
              });
            } else {
              migrationNote.classList.remove('visible');
            }

            chrome.runtime.sendMessage({
              action: 'kinto-save',
              content
            });

            chrome.runtime.sendMessage({
              action: 'metrics-changed',
              context: getPadStats(editor)
            });
          }
          ignoreNextLoadEvent = false;
        }
      });

      savingIndicator.onclick = () => {
        enableSyncAction(editor);
      };
      // to make reconnectSync text Field act like savingIndicator
      enableSync.onclick = () => {
        enableSyncAction(editor);
      };

      customizeEditor(editor);
      loadContent();

      chrome.runtime.onMessage.addListener(eventData => {
        let content;
        switch (eventData.action) {
          case 'sync-authenticated':
            setAnimation(true, true, false); // animateSyncIcon, syncingLayout, warning
            isAuthenticated = true;
            waitingToReconnect = false;
            clearTimeout(loginTimeout);
            // set title attr of footer to the currently logged in account
            if (eventData.profile) {
              footerButtons.title = `${browser.i18n.getMessage('syncToMail', eventData.profile.email)}`;
            }
            localStorage.setItem('userEmail', footerButtons.title);
            savingIndicator.textContent = browser.i18n.getMessage('syncProgress');
            browser.runtime.sendMessage({
              action: 'kinto-sync'
            });
            break;
          case 'kinto-loaded':
            clearTimeout(loginTimeout);
            content = eventData.data;
            // Switch to Date.now() to show when we pulled notes instead of 'eventData.last_modified'
            lastModified = Date.now();
            getLastSyncedTime();
            handleLocalContent(editor, content);
            document.getElementById('loading').style.display = 'none';
            break;
          case 'text-change':
            ignoreNextLoadEvent = true;
            browser.runtime.sendMessage({
              action: 'kinto-load'
            });
            break;
          case 'text-syncing':
            setAnimation(true); // animateSyncIcon, syncingLayout, warning
            savingIndicator.textContent = browser.i18n.getMessage('syncProgress');
            // Disable sync-action
            syncingInProcess = true;
            break;
          case 'text-editing':
            if (isAuthenticated) {
              setAnimation(true); // animateSyncIcon, syncingLayout, warning
              syncingInProcess = true;
            }
            if (!waitingToReconnect) {
              if (isAuthenticated) {
                savingIndicator.textContent = browser.i18n.getMessage('syncProgress');
              } else {
                savingIndicator.textContent = browser.i18n.getMessage('savingChanges');
              }
            }
            // Disable sync-action
            editingInProcess = true;
            break;
          case 'text-synced':
            lastModified = eventData.last_modified;
            if (!ignoreTextSynced || eventData.conflict) {
              handleLocalContent(editor, eventData.content);
            }
            ignoreTextSynced = false;
            getLastSyncedTime();
            // Enable sync-action
            syncingInProcess = false;
            break;
          case 'text-saved':
            if (!waitingToReconnect && !isAuthenticated) {
              // persist reconnect warning, do not override with the 'saved at'
              savingIndicator.textContent = browser.i18n.getMessage('savedComplete2', formatFooterTime());
            }
            // Enable sync-action
            editingInProcess = false;
            break;
          case 'reconnect':
            clearTimeout(loginTimeout);
            reconnectSync();
            // Enable sync-action
            syncingInProcess = false;
            break;
          case 'disconnected':
            giveFeedbackButton.style.display = 'inherit';
            localStorage.removeItem('userEmail');
            disconnectSync.style.display = 'none';
            footerButtons.removeAttribute('title');// remove profile email from title attribute
            isAuthenticated = false;
            setAnimation(false, false, false); // animateSyncIcon, syncingLayout, warning
            getLastSyncedTime();
            break;
        }
      });
    });

}).catch(error => {
  console.error(error); // eslint-disable-line no-console
});

function loadContent() {
  browser.storage.local.get('credentials').then((data) => {
    if (data.hasOwnProperty('credentials')) {
      isAuthenticated = true;
      const userEmail = localStorage.getItem('userEmail');
      if (userEmail) {
        footerButtons.title = userEmail;
      }
    }
  });
  chrome.runtime.sendMessage({
    action: 'kinto-load'  // Load locally.
  });

}

function handleLocalContent(editor, content) {
  if (!content) {
    browser.storage.local.get('notes2').then((data) => {
      if (!data.hasOwnProperty('notes2')) {
        editor.setData(INITIAL_CONTENT);
        ignoreNextLoadEvent = true;
      } else {
        editor.setData(data.notes2);
        chrome.runtime.sendMessage({
          action: 'kinto-save',
          content: data.notes2
        }).then(() => {
          // Clean-up
          browser.storage.local.remove('notes2');
        });
      }
    });
  } else if (editor.getData() !== content) {
      // Prevent from loading too big content but allow for conflict handling.
      editor.setData(content);
    }
}

function reconnectSync() {
  waitingToReconnect = true;
  isAuthenticated = false;
  setAnimation(false, true, true); // animateSyncIcon, syncingLayout, warning
  savingIndicator.textContent = browser.i18n.getMessage('reconnectSync');
  chrome.runtime.sendMessage({
    action: 'metrics-reconnect-sync'
  });
}

function disconnectFromSync() {
  waitingToReconnect = false;
  disconnectSync.style.display = 'none';
  isAuthenticated = false;
  setAnimation(false, false, false); // animateSyncIcon, syncingLayout, warning
  setTimeout(() => {
    savingIndicator.textContent = browser.i18n.getMessage('disconnected');
  }, 200);
  setTimeout(() => {
    getLastSyncedTime();
  }, 2000);
  browser.runtime.sendMessage('notes@mozilla.com', {
    action: 'disconnected'
  });
}

disconnectSync.addEventListener('click', disconnectFromSync);

function enableSyncAction(editor) {
  if (editingInProcess || syncingInProcess) {
    return;
  }

  if (isAuthenticated && footerButtons.classList.contains('syncingLayout')) {
    // Trigger manual sync
    giveFeedbackButton.style.display = 'none';
    setAnimation(true);
    browser.runtime.sendMessage({
        action: 'kinto-sync'
      });
  } else if (!isAuthenticated && (footerButtons.classList.contains('savingLayout') || waitingToReconnect)) {
    // Login
    giveFeedbackButton.style.display = 'none';
    setAnimation(true, true, false); // animateSyncIcon, syncingLayout, warning

    // enable disable sync button
    disconnectSync.style.display = 'block';

    setTimeout(() => {
      savingIndicator.textContent = browser.i18n.getMessage('openingLogin');
    }, 200); // Delay text for smooth animation

    loginTimeout = setTimeout(() => {
      setAnimation(false, true, true); // animateSyncIcon, syncingLayout, warning
      savingIndicator.textContent = browser.i18n.getMessage('pleaseLogin');
      waitingToReconnect = true;
    }, 5000);

    browser.runtime.sendMessage({
      action: 'authenticate',
      context: getPadStats(editor)
    });
  }

  waitingToReconnect = false;
}

function getLastSyncedTime() {
  if (waitingToReconnect) {
    // persist reconnect warning, do not override with the 'saved at'
    return;
  }

  if (isAuthenticated) {
    giveFeedbackButton.style.display = 'none';
    // eslint-disable-next-line no-unsanitized/property
    savingIndicator.innerHTML = browser.i18n.getMessage('syncComplete3', formatFooterTime(lastModified));
    disconnectSync.style.display = 'block';
    isAuthenticated = true;
    setAnimation(false, true, false, true); // animateSyncIcon, syncingLayout, warning, syncSuccess
  } else {
    savingIndicator.textContent = browser.i18n.getMessage('changesSaved', formatFooterTime());
  }
}

document.addEventListener('DOMContentLoaded', getLastSyncedTime);

// Create a connection with the background script to handle open and
// close events.
browser.runtime.connect();
