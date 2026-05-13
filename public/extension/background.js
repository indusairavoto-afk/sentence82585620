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
                      const seenMessageIds = new Set();
                      const allMessagesHTML = [];
                      
                      const collectMessages = () => {
                        const messages = document.querySelectorAll('.font-user-message, .font-claude-message, [data-message-author-role], article, [data-testid="message"]');
                        messages.forEach(msg => {
                          const id = msg.id || msg.getAttribute('data-message-id') || (msg.innerText ? msg.innerText.substring(0, 50) : '') + '-' + msg.innerHTML.length;
                          if (!seenMessageIds.has(id)) {
                            seenMessageIds.add(id);
                            allMessagesHTML.push('<div>' + msg.outerHTML + '</div>');
                          }
                        });
                      };

                      const findScrollContainer = () => {
                        const main = document.querySelector('main');
                        if (main && main.scrollHeight > main.clientHeight + 10) return main;
                        const divs = Array.from(document.querySelectorAll('div.flex-1.overflow-y-auto, div[class*="overflow"]'));
                        for (let d of divs) {
                          if (d.scrollHeight > d.clientHeight + 10) return d;
                        }
                        return document.scrollingElement || document.body;
                      };

                      let phase = 'up'; // first scroll up to load old history
                      let scrollAttempts = 0;
                      let noChangeCount = 0;
                      
                      const scrollStep = () => {
                        collectMessages();
                        const scroller = findScrollContainer();
                        const oldHeight = scroller.scrollHeight;
                        const oldTop = scroller.scrollTop;

                        // Scroll by smaller increments (600px) so we don't skip over virtualized items
                        if (phase === 'up') {
                          scroller.scrollTo(0, Math.max(0, oldTop - 600));
                          window.scrollTo(0, Math.max(0, window.scrollY - 600));
                        } else {
                          scroller.scrollTo(0, oldTop + 600);
                          window.scrollTo(0, window.scrollY + 600);
                        }
                        
                        scrollAttempts++;

                        setTimeout(() => {
                           collectMessages();
                           const newHeight = scroller.scrollHeight;
                           const newTop = scroller.scrollTop;
                           
                           // If we hit the boundary
                           const hitBoundary = phase === 'up' ? newTop <= 0 : (newTop + scroller.clientHeight >= newHeight - 10);
                           
                           if (hitBoundary || (newTop === oldTop && newHeight === oldHeight)) {
                             noChangeCount++;
                           } else {
                             noChangeCount = 0;
                           }

                           if (noChangeCount >= 4) {
                             if (phase === 'up') {
                               // Switch direction
                               phase = 'down';
                               noChangeCount = 0;
                               scrollStep();
                             } else {
                               // Done with down as well
                               collectMessages();
                               resolve('<html>' + document.head.outerHTML + '<body>' + allMessagesHTML.join('') + '</body></html>');
                             }
                           } else if (scrollAttempts > 250) {
                             // Absolute fallback timeout
                             collectMessages();
                             resolve('<html>' + document.head.outerHTML + '<body>' + allMessagesHTML.join('') + '</body></html>');
                           } else {
                             scrollStep();
                           }
                        }, 500);
                      };
                      
                      // Start at the bottom so scrolling up has maximum effect, then down
                      const initialScroller = findScrollContainer();
                      initialScroller.scrollTo(0, initialScroller.scrollHeight);
                      
                      setTimeout(scrollStep, 500);
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
