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
              // Look specifically for actual message blocks, ignore skeletons
              const hasMessages = document.querySelectorAll('.font-user-message, .font-claude-message, [data-message-author-role], article, [data-testid="message"]').length > 0;
              return { hasMessages, html: document.documentElement.outerHTML };
            }
          }, (results) => {
            attempts++;
            if (chrome.runtime.lastError || !results || !results[0]) {
              // Might be redirecting or not ready yet
              if (attempts > 30) { // 15 seconds max
                chrome.tabs.remove(tabId);
                sendResponse({ html: null, success: false });
              } else {
                setTimeout(checkReady, 500);
              }
              return;
            }
            
            const data = results[0].result;
            // Wait until messages are injected, OR if we're hitting a wall (e.g., 404, or needs login)
            const isErrorPage = data.html && (data.html.includes("Can't load shared conversation") || data.html.includes("conversation you requested could not be found"));
            
            if (data.hasMessages || isErrorPage || attempts > 30) {
              chrome.tabs.remove(tabId);
              sendResponse({ html: data.html, success: !!data.html });
            } else {
              setTimeout(checkReady, 500);
            }
          });
        };

        // Start polling immediately
        setTimeout(checkReady, 1000);
      });
      
      // Return true to indicate we will send a response asynchronously
      return true;
    }
  }
);
