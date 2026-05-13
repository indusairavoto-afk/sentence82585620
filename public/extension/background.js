chrome.runtime.onMessageExternal.addListener(
  (request, sender, sendResponse) => {
    if (request.action === 'fetch_html' && request.url) {
      console.log('Received request to fetch:', request.url);
      
      // Open tab in background
      chrome.tabs.create({ url: request.url, active: false }, (tab) => {
        const tabId = tab.id;
        
        let attempts = 0;
        
        const checkReady = () => {
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
              // Check if we have message nodes or if 8 seconds have passed (fallback)
              const hasMessages = document.querySelectorAll('[data-message-author-role], article, .message').length > 0;
              return { hasMessages, html: document.documentElement.outerHTML };
            }
          }, (results) => {
            attempts++;
            if (chrome.runtime.lastError || !results || !results[0]) {
              if (attempts > 10) {
                chrome.tabs.remove(tabId);
                sendResponse({ html: null, success: false });
              } else {
                setTimeout(checkReady, 1000);
              }
              return;
            }
            
            const data = results[0].result;
            if (data.hasMessages || attempts > 10) {
              chrome.tabs.remove(tabId);
              sendResponse({ html: data.html, success: !!data.html });
            } else {
              setTimeout(checkReady, 1000);
            }
          });
        };

        const listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(checkReady, 500); // Start polling when document status is complete
          }
        };
        
        chrome.tabs.onUpdated.addListener(listener);
      });
      
      // Return true to indicate we will send a response asynchronously
      return true;
    }
  }
);
