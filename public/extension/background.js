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

                      const triggerScrolls = (yPos) => {
                          try { window.scrollTo(0, yPos); } catch (e) {}
                          const scrollers = [
                            document.querySelector('div[class*="react-scroll-to-bottom"]'),
                            document.querySelector('main div.flex-1.overflow-y-auto'),
                            document.querySelector('main'),
                            ...Array.from(document.querySelectorAll('div[class*="overflow"]'))
                          ].filter(Boolean);
                          for (const s of scrollers) {
                              try { s.scrollTo(0, yPos); } catch (e) {}
                          }
                      };

                      let upAttempts = 0;
                      let downAttempts = 0;
                      let downNoChangeCount = 0;
                      
                      const scrollDownStep = () => {
                          collectMessages();
                          
                          const mainScroller = document.querySelector('div[class*="react-scroll-to-bottom"]') || 
                                               document.querySelector('main div.flex-1.overflow-y-auto') ||
                                               Array.from(document.querySelectorAll('div[class*="overflow"]')).sort((a,b) => b.scrollHeight - a.scrollHeight)[0] || 
                                               document.scrollingElement || document.body;
                          
                          const oldHeight = mainScroller.scrollHeight;
                          const oldTop = mainScroller.scrollTop;
                          
                          const yPos = oldTop + 800; // slightly bigger chunks
                          triggerScrolls(yPos);
                          downAttempts++;
                          
                          setTimeout(() => {
                              const newHeight = mainScroller.scrollHeight;
                              const newTop = mainScroller.scrollTop;
                              
                              const hitBottom = (newTop + mainScroller.clientHeight >= newHeight - 10);
                              if (hitBottom || (newTop === oldTop && newHeight === oldHeight)) {
                                  downNoChangeCount++;
                              } else {
                                  downNoChangeCount = 0;
                              }
                              
                              if (downNoChangeCount >= 4 || downAttempts > 300) {
                                  collectMessages(); // final collect
                                  resolve('<html>' + document.head.outerHTML + '<body>' + allMessagesHTML.join('') + '</body></html>');
                              } else {
                                  scrollDownStep();
                              }
                          }, 400); 
                      };

                      let lastUpHeight = 0;
                      let upNoChangeCount = 0;

                      const scrollUpStep = () => {
                          const mainScroller = document.querySelector('div[class*="react-scroll-to-bottom"]') || 
                                               document.querySelector('main div.flex-1.overflow-y-auto') ||
                                               Array.from(document.querySelectorAll('div[class*="overflow"]')).sort((a,b) => b.scrollHeight - a.scrollHeight)[0] || 
                                               document.scrollingElement || document.body;
                                               
                          const currentHeight = mainScroller.scrollHeight;
                          triggerScrolls(0);
                          upAttempts++;
                          
                          if (currentHeight === lastUpHeight) {
                              upNoChangeCount++;
                          } else {
                              upNoChangeCount = 0;
                              lastUpHeight = currentHeight;
                          }
                          
                          // stop jumping up if we hit the top 5 times in a row, or max 12 jumps (to prevent infinite loops)
                          if (upNoChangeCount >= 4 || upAttempts > 15) { 
                             setTimeout(() => {
                                seenMessageIds.clear();
                                allMessagesHTML.length = 0;
                                scrollDownStep();
                             }, 500);
                          } else {
                             setTimeout(scrollUpStep, 600);
                          }
                      };
                      
                      // Start jumping up
                      scrollUpStep();
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
