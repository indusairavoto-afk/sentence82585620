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
            
            const data = results[0].result || {};
            // Wait until messages are injected, OR if we're hitting a wall (e.g., 404, or needs login)
            const isErrorPage = data.html && (data.html.includes("Can't load shared conversation") || data.html.includes("conversation you requested could not be found"));
            
            if (data.hasMessages || isErrorPage || attempts > 30) {
              if (data.hasMessages && attempts <= 30) {
                // Try scrolling down to load lazy-load messages
                chrome.scripting.executeScript({
                  target: { tabId: tabId },
                  func: async () => {
                    return new Promise((resolve) => {
                      let lastHeight = 0;
                      let scrollAttempts = 0;
                      const scrollElement = document.querySelector('main') || document.body;
                      const seenMessageIds = new Set();
                      const allMessagesHTML = [];
                      
                      const collectMessages = () => {
                        const messages = document.querySelectorAll('.font-user-message, .font-claude-message, [data-message-author-role], article, [data-testid="message"]');
                        messages.forEach(msg => {
                          const id = msg.id || msg.getAttribute('data-message-id') || msg.innerText.substring(0, 50);
                          if (!seenMessageIds.has(id)) {
                            seenMessageIds.add(id);
                            // wrap in div just to be safe
                            allMessagesHTML.push('<div>' + msg.outerHTML + '</div>');
                          }
                        });
                      };

                      const scrollInterval = setInterval(() => {
                        collectMessages();
                        scrollElement.scrollTo(0, scrollElement.scrollHeight);
                        scrollAttempts++;
                        
                        if (scrollElement.scrollHeight === lastHeight || scrollAttempts > 20) {
                          setTimeout(() => {
                            collectMessages(); // final collect
                            clearInterval(scrollInterval);
                            resolve('<html>' + document.head.outerHTML + '<body>' + allMessagesHTML.join('') + '</body></html>');
                          }, 1000);
                        } else {
                          lastHeight = scrollElement.scrollHeight;
                        }
                      }, 500);
                    });
                  }
                }, (finalResults) => {
                  chrome.tabs.remove(tabId);
                  if (finalResults && finalResults[0]) {
                    sendResponse({ html: finalResults[0].result, success: true });
                  } else {
                    sendResponse({ html: data.html, success: true });
                  }
                });
              } else {
                chrome.tabs.remove(tabId);
                sendResponse({ html: data.html, success: !!data.html });
              }
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
