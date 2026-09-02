async function executeUploadLogic(e) {
    var isSelfieSubmit = (e && e.target && e.target.id === 'submitSelfieBtn') || (this && this.id === 'submitSelfieBtn');
    var activeStatusMsg = isSelfieSubmit ? statusMessageSelfie : statusMessage;
    var activeReasonBox = isSelfieSubmit ? detailedReasonBoxSelfie : detailedReasonBox;
    var activeRetryBtn = isSelfieSubmit ? retryUploadBtnSelfie : retryUploadBtn;

    var filesToUpload = isSelfieSubmit ? [selectedFile] : selectedFiles;

    if (!filesToUpload || filesToUpload.length === 0 || !filesToUpload[0] || !userEmailAddress) { 
      if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">Please select a file and ensure you are logged in.</span>';
      return;
    }

    var taskType = isSelfieSubmit ? 'selfie' : (taskTypeSelect ? taskTypeSelect.value : 'notes');
    var contentTags = [];
    
    if (taskType === 'notes') {
      var consentSensitive = document.getElementById('consentSensitive');
      var consentCommercial = document.getElementById('consentCommercial');
      if ((consentSensitive && !consentSensitive.checked) || (consentCommercial && !consentCommercial.checked)) { 
          if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">You must agree to the Legal Consents before uploading.</span>';
          return; 
      }
      var docLanguageInput = document.getElementById('docLanguageInput');
      if (docLanguageInput && docLanguageInput.value.trim() === "") { 
          if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">Please specify the language used in the notes.</span>';
          return; 
      }
      var tagCheckboxes = document.querySelectorAll('.doc-tag:checked');
      tagCheckboxes.forEach(function(cb) { contentTags.push(cb.value); });
      if (contentTags.length === 0) { 
          if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">Please select at least one content tag.</span>';
          return; 
      }
    } else if (taskType === 'selfie') {
      var consentAgeSelfie = document.getElementById('consentAgeSelfie');
      var consentSensitiveSelfie = document.getElementById('consentSensitiveSelfie');
      var consentCommercialSelfie = document.getElementById('consentCommercialSelfie');
      
      if ((consentAgeSelfie && !consentAgeSelfie.checked) || 
          (consentSensitiveSelfie && !consentSensitiveSelfie.checked) || 
          (consentCommercialSelfie && !consentCommercialSelfie.checked)) {
          if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">You must agree to the Legal Consents before uploading.</span>';
          return; 
      }
    }

    if (submitDocBtn) submitDocBtn.disabled = true;
    if (submitSelfieBtn) submitSelfieBtn.disabled = true;

    // ---- SELFIE: Use original single-file legacy endpoint ----
    if (isSelfieSubmit) {
      updateProgressUI('Compressing and securing payload...', 15, activeStatusMsg);
      try {
        var base64String = await compressImageForBackend(selectedFile, 500, 0.4);
        var payload = {
          email: userEmailAddress,
          userEmail: userEmailAddress, 
          taskType: taskType, 
          fileName: selectedFile.name || 'capture.jpg', 
          imageBase64: base64String,
          contentTags: contentTags.length > 0 ? contentTags : ['none']
        };

        var response = await fetch(BACKEND_URL + "/api/upload-task", {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });

        if (!response.ok) {
          var errorMsg = 'Upload rejected by server.';
          try {
              var data = await response.json();
              errorMsg = data.error || data.message || 'Server blocked request (Status ' + response.status + ')';
          } catch(parseErr) {
              errorMsg = 'Backend Firewall Blocked Request (Status ' + response.status + '). Payload might be too large.';
          }
          if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">X <strong>' + errorMsg + '</strong></span>';
          if (submitDocBtn) submitDocBtn.disabled = false;
          if (submitSelfieBtn) submitSelfieBtn.disabled = false;
          return;
        }

        var attempts = 0;
        var maxAttempts = 15;
        updateProgressUI('AI is verifying parameters...', 35, activeStatusMsg);
        if (currentPollInterval) clearTimeout(currentPollInterval);

        var pollStatus = async function() {
            attempts++;
            if(attempts === 2) updateProgressUI('Analyzing vectors and embeddings...', 60, activeStatusMsg);
            if(attempts === 5) updateProgressUI('Security & anti-spoofing verification...', 85, activeStatusMsg);

            try {
                var res = await fetch(BACKEND_URL + "/api/check-submission?email=" + encodeURIComponent(userEmailAddress));
                var checkData = await res.json();
                
                if (checkData.success && checkData.submission) {
                    var status = checkData.submission.status;
                    var reason = checkData.submission.reason || "System processing error.";
                    
                    if (status === 'verified' || status === 'approved') {
                        await runProfileLedgerVerification(userEmailAddress, false, true); 
                        if (submitDocBtn) submitDocBtn.style.display = 'none';
                        if (submitSelfieBtn) submitSelfieBtn.style.display = 'none';
                        var cleanReason = reason.split('|')[0].trim();
                        if (activeStatusMsg) {
                            activeStatusMsg.innerHTML = 
                                '<div style="background: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 16px; padding: 25px 20px; text-align: center; animation: slideUpFade 0.5s ease-out; margin-top: 15px;">' +
                                    '<div style="width: 56px; height: 56px; background: #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 15px; box-shadow: 0 0 20px rgba(16, 185, 129, 0.4);">' +
                                        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
                                    '</div>' +
                                    '<div style="font-weight: 900; color: #10b981; font-size: 20px; margin-bottom: 5px; letter-spacing: -0.5px;">VERIFICATION SUCCESSFUL</div>' +
                                    '<div style="color: #a1a1aa; font-size: 14px; margin-bottom: 20px;">' + cleanReason + '</div>' +
                                    '<div style="background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 12px; display: inline-block;">' +
                                        '<span style="color: #fbbf24; font-weight: 900; font-size: 18px;">+48 SYNX</span>' +
                                        '<span style="color: #71717a; font-size: 11px; display: block; margin-top: 3px; font-weight: 600; text-transform: uppercase;">Tokens Assigned to Ledger</span>' +
                                    '</div>' +
                                '</div>';
                        }
                        if(activeReasonBox) activeReasonBox.style.display = 'none'; 
                        if (activeRetryBtn) activeRetryBtn.style.display = 'block'; 
                        return;
                    } 
                    else if (status === 'rejected' || status === 'rejected_pii' || status === 'fraud' || status === 'duplicate') {
                        if (submitDocBtn) submitDocBtn.style.display = 'none';
                        if (submitSelfieBtn) submitSelfieBtn.style.display = 'none';
                        if (activeStatusMsg) {
                            activeStatusMsg.innerHTML = 
                                '<div style="background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 16px; padding: 25px 20px; text-align: center; animation: slideUpFade 0.5s ease-out; margin-top: 15px;">' +
                                    '<div style="width: 56px; height: 56px; background: #ef4444; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 15px; box-shadow: 0 0 20px rgba(239, 68, 68, 0.4);">' +
                                        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
                                    '</div>' +
                                    '<div style="font-weight: 900; color: #ef4444; font-size: 20px; margin-bottom: 5px; letter-spacing: -0.5px;">VERIFICATION FAILED</div>' +
                                    '<div style="color: #fca5a5; font-size: 14px; background: rgba(239, 68, 68, 0.1); padding: 10px; border-radius: 8px; margin-top: 15px;">' + reason + '</div>' +
                                '</div>';
                        }
                        if(activeReasonBox) activeReasonBox.style.display = 'none';
                        if (activeRetryBtn) activeRetryBtn.style.display = 'block';
                        return;
                    }
                }
                
                if (attempts >= maxAttempts) {
                    if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ea580c; font-weight:700;">AI timed out. Please check network and try again.</span>';
                    if (submitDocBtn) { submitDocBtn.disabled = false; submitDocBtn.innerText = 'Approve & Submit to Waiting Room'; }
                    if (submitSelfieBtn) { submitSelfieBtn.disabled = false; submitSelfieBtn.innerText = 'Verify & Submit to Waiting Room'; }
                    if (activeRetryBtn) activeRetryBtn.style.display = 'block';
                    return;
                }
            } catch (pollErr) { console.error("Polling error", pollErr); }
            
            currentPollInterval = setTimeout(pollStatus, 3000);
        };
        
        currentPollInterval = setTimeout(pollStatus, 3000); 

      } catch (error) {
        if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">Network error. Could not establish connection.</span>';
        if (submitDocBtn) submitDocBtn.disabled = false;
        if (submitSelfieBtn) submitSelfieBtn.disabled = false;
      }
      return; // Exit — selfie flow done
    }

    // ================================================================
    // DOCUMENT BATCH UPLOAD — Multi-file → /api/uploads/batch
    // ================================================================
    updateProgressUI('Compressing ' + filesToUpload.length + ' file(s)...', 10, activeStatusMsg);

    try {
      // ---- 1. Compress all files in parallel ----
      var compressionPromises = filesToUpload.map(function(file) {
        return compressImageForBackend(file, 500, 0.4).then(function(base64) {
          return { fileName: file.name || 'capture.jpg', base64: base64 };
        });
      });
      var compressedFiles = await Promise.all(compressionPromises);

      updateProgressUI('Uploading batch to secure queue...', 30, activeStatusMsg);

      // ---- 2. Build batch payload ----
      var batchPayload = {
        userEmail: userEmailAddress,
        files: compressedFiles.map(function(cf) {
          return {
            taskType: taskType,
            fileName: cf.fileName,
            imageBase64: cf.base64,
            contentTags: contentTags.length > 0 ? contentTags : ['none']
          };
        })
      };

      // ---- 3. Send to batch endpoint ----
      var batchResponse = await fetch(BACKEND_URL + "/api/uploads/batch", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchPayload)
      });

      if (!batchResponse.ok) {
        var errMsg = 'Batch upload rejected by server.';
        try {
          var errData = await batchResponse.json();
          errMsg = errData.error || errData.message || 'Server blocked batch (Status ' + batchResponse.status + ')';
        } catch(pe) {
          errMsg = 'Backend rejected batch (Status ' + batchResponse.status + ')';
        }
        if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">X <strong>' + errMsg + '</strong></span>';
        if (submitDocBtn) submitDocBtn.disabled = false;
        return;
      }

      var batchResult = await batchResponse.json();
      if (!batchResult.success || !batchResult.batchId) {
        if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">Batch creation failed. ' + (batchResult.message || '') + '</span>';
        if (submitDocBtn) submitDocBtn.disabled = false;
        return;
      }

      // ---- 4. Fire and Forget UX ----
      if (submitDocBtn) submitDocBtn.style.display = 'none';
      if (activeReasonBox) activeReasonBox.style.display = 'none';
      
      if (activeStatusMsg) {
        activeStatusMsg.innerHTML = 
          '<div style="background: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 16px; padding: 25px 20px; text-align: center; animation: slideUpFade 0.5s ease-out; margin-top: 15px;">' +
              '<div style="width: 56px; height: 56px; background: #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 15px; box-shadow: 0 0 20px rgba(16, 185, 129, 0.4);">' +
                  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
              '</div>' +
              '<div style="font-weight: 900; color: #10b981; font-size: 20px; margin-bottom: 5px; letter-spacing: -0.5px;">UPLOAD SUCCESSFUL! 🎉</div>' +
              '<div style="color: #a1a1aa; font-size: 14px; margin-bottom: 20px; line-height: 1.5;">Your files are in the AI queue. You can safely close this page. Check the \'History\' tab for your results and rewards.</div>' +
              '<button type="button" onclick="resetUploadState(false)" style="background: #ffffff; color: #000000; font-weight: 800; border: none; padding: 12px 24px; border-radius: 12px; cursor: pointer; font-size: 14px; transition: opacity 0.2s;">Upload More</button>' +
          '</div>';
      }

    } catch (error) {
      console.error("Batch upload error:", error);
      if (activeStatusMsg) activeStatusMsg.innerHTML = '<span style="color:#ef4444;">Network error. Could not establish connection.</span>';
      if (submitDocBtn) submitDocBtn.disabled = false;
    }
}
