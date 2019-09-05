/* -*- Mode: Java; c-basic-offset: 4; tab-width: 4; indent-tabs-mode: nil; -*-
 * Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

package org.mozilla.geckoview.test

import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.test.rule.GeckoSessionTestRule.AssertCalled
import org.mozilla.geckoview.test.rule.GeckoSessionTestRule.WithDisplay
import org.mozilla.geckoview.test.util.Callbacks

import android.support.test.filters.MediumTest
import android.support.test.filters.LargeTest
import android.support.test.runner.AndroidJUnit4

import org.hamcrest.Matchers.*
import org.junit.Assume.assumeThat
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@MediumTest
class ProgressDelegateTest : BaseSessionTest() {

    @Test fun loadProgress() {
        sessionRule.session.loadTestPath(HELLO_HTML_PATH)
        sessionRule.waitForPageStop()

        var counter = 0
        var lastProgress = -1

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled
            override fun onProgressChange(session: GeckoSession, progress: Int) {
                assertThat("Progress must be strictly increasing", progress,
                           greaterThan(lastProgress))
                lastProgress = progress
                counter++
            }
        })

        assertThat("Callback should be called at least twice", counter,
                   greaterThanOrEqualTo(2))
        assertThat("Last progress value should be 100", lastProgress,
                   equalTo(100))
    }


    @Test fun load() {
        sessionRule.session.loadTestPath(HELLO_HTML_PATH)
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1, order = [1])
            override fun onPageStart(session: GeckoSession, url: String) {
                assertThat("Session should not be null", session, notNullValue())
                assertThat("URL should not be null", url, notNullValue())
                assertThat("URL should match", url, endsWith(HELLO_HTML_PATH))
            }

            @AssertCalled(count = 1, order = [2])
            override fun onSecurityChange(session: GeckoSession,
                                          securityInfo: GeckoSession.ProgressDelegate.SecurityInformation) {
                assertThat("Session should not be null", session, notNullValue())
                assertThat("Security info should not be null", securityInfo, notNullValue())

                assertThat("Should not be secure", securityInfo.isSecure, equalTo(false))
            }

            @AssertCalled(count = 1, order = [3])
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                assertThat("Session should not be null", session, notNullValue())
                assertThat("Load should succeed", success, equalTo(true))
            }
        })
    }

    @Ignore
    @Test fun multipleLoads() {
        sessionRule.session.loadUri(UNKNOWN_HOST_URI)
        sessionRule.session.loadTestPath(HELLO_HTML_PATH)
        sessionRule.waitForPageStops(2)

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 2, order = [1, 3])
            override fun onPageStart(session: GeckoSession, url: String) {
                assertThat("URL should match", url,
                           endsWith(forEachCall(UNKNOWN_HOST_URI, HELLO_HTML_PATH)))
            }

            @AssertCalled(count = 2, order = [2, 4])
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                // The first load is certain to fail because of interruption by the second load
                // or by invalid domain name, whereas the second load is certain to succeed.
                assertThat("Success flag should match", success,
                           equalTo(forEachCall(false, true)))
            };
        })
    }

    @Test fun reload() {
        sessionRule.session.loadTestPath(HELLO_HTML_PATH)
        sessionRule.waitForPageStop()

        sessionRule.session.reload()
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1, order = [1])
            override fun onPageStart(session: GeckoSession, url: String) {
                assertThat("URL should match", url, endsWith(HELLO_HTML_PATH))
            }

            @AssertCalled(count = 1, order = [2])
            override fun onSecurityChange(session: GeckoSession,
                                          securityInfo: GeckoSession.ProgressDelegate.SecurityInformation) {
            }

            @AssertCalled(count = 1, order = [3])
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                assertThat("Load should succeed", success, equalTo(true))
            }
        })
    }

    @Test fun goBackAndForward() {
        sessionRule.session.loadTestPath(HELLO_HTML_PATH)
        sessionRule.waitForPageStop()
        sessionRule.session.loadTestPath(HELLO2_HTML_PATH)
        sessionRule.waitForPageStop()

        sessionRule.session.goBack()
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1, order = [1])
            override fun onPageStart(session: GeckoSession, url: String) {
                assertThat("URL should match", url, endsWith(HELLO_HTML_PATH))
            }

            @AssertCalled(count = 1, order = [2])
            override fun onSecurityChange(session: GeckoSession,
                                          securityInfo: GeckoSession.ProgressDelegate.SecurityInformation) {
            }

            @AssertCalled(count = 1, order = [3])
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                assertThat("Load should succeed", success, equalTo(true))
            }
        })

        sessionRule.session.goForward()
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1, order = [1])
            override fun onPageStart(session: GeckoSession, url: String) {
                assertThat("URL should match", url, endsWith(HELLO2_HTML_PATH))
            }

            @AssertCalled(count = 1, order = [2])
            override fun onSecurityChange(session: GeckoSession,
                                          securityInfo: GeckoSession.ProgressDelegate.SecurityInformation) {
            }

            @AssertCalled(count = 1, order = [3])
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                assertThat("Load should succeed", success, equalTo(true))
            }
        })
    }

    @Test fun correctSecurityInfoForValidTLS_automation() {
        assumeThat(sessionRule.env.isAutomation, equalTo(true))

        sessionRule.session.loadUri("https://example.com")
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1)
            override fun onSecurityChange(session: GeckoSession,
                                          securityInfo: GeckoSession.ProgressDelegate.SecurityInformation) {
                assertThat("Should be secure",
                           securityInfo.isSecure, equalTo(true))
                assertThat("Should not be exception",
                           securityInfo.isException, equalTo(false))
                assertThat("Origin should match",
                           securityInfo.origin,
                           equalTo("https://example.com"))
                assertThat("Host should match",
                           securityInfo.host,
                           equalTo("example.com"))
                assertThat("Organization should match",
                           securityInfo.organization,
                           equalTo(""))
                assertThat("Subject name should match",
                           securityInfo.subjectName,
                           equalTo("CN=example.com"))
                assertThat("Issuer common name should match",
                           securityInfo.issuerCommonName,
                           equalTo("Temporary Certificate Authority"))
                assertThat("Issuer organization should match",
                           securityInfo.issuerOrganization,
                           equalTo("Mozilla Testing"))
                assertThat("Security mode should match",
                           securityInfo.securityMode,
                           equalTo(GeckoSession.ProgressDelegate.SecurityInformation.SECURITY_MODE_IDENTIFIED))
                assertThat("Active mixed mode should match",
                           securityInfo.mixedModeActive,
                           equalTo(GeckoSession.ProgressDelegate.SecurityInformation.CONTENT_UNKNOWN))
                assertThat("Passive mixed mode should match",
                           securityInfo.mixedModePassive,
                           equalTo(GeckoSession.ProgressDelegate.SecurityInformation.CONTENT_UNKNOWN))
            }
        })
    }

    @LargeTest
    @Test fun correctSecurityInfoForValidTLS_local() {
        assumeThat(sessionRule.env.isAutomation, equalTo(false))

        sessionRule.session.loadUri("https://mozilla-modern.badssl.com")
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1)
            override fun onSecurityChange(session: GeckoSession,
                                          securityInfo: GeckoSession.ProgressDelegate.SecurityInformation) {
                assertThat("Should be secure",
                           securityInfo.isSecure, equalTo(true))
                assertThat("Should not be exception",
                           securityInfo.isException, equalTo(false))
                assertThat("Origin should match",
                           securityInfo.origin,
                           equalTo("https://mozilla-modern.badssl.com"))
                assertThat("Host should match",
                           securityInfo.host,
                           equalTo("mozilla-modern.badssl.com"))
                assertThat("Organization should match",
                           securityInfo.organization,
                           equalTo("Lucas Garron"))
                assertThat("Subject name should match",
                           securityInfo.subjectName,
                           equalTo("CN=*.badssl.com,O=Lucas Garron,L=Walnut Creek,ST=California,C=US"))
                assertThat("Issuer common name should match",
                           securityInfo.issuerCommonName,
                           equalTo("DigiCert SHA2 Secure Server CA"))
                assertThat("Issuer organization should match",
                           securityInfo.issuerOrganization,
                           equalTo("DigiCert Inc"))
                assertThat("Security mode should match",
                           securityInfo.securityMode,
                           equalTo(GeckoSession.ProgressDelegate.SecurityInformation.SECURITY_MODE_IDENTIFIED))
                assertThat("Active mixed mode should match",
                           securityInfo.mixedModeActive,
                           equalTo(GeckoSession.ProgressDelegate.SecurityInformation.CONTENT_UNKNOWN))
                assertThat("Passive mixed mode should match",
                           securityInfo.mixedModePassive,
                           equalTo(GeckoSession.ProgressDelegate.SecurityInformation.CONTENT_UNKNOWN))
            }
        })
    }

    @LargeTest
    @Test fun noSecurityInfoForExpiredTLS() {
        sessionRule.session.loadUri(if (sessionRule.env.isAutomation)
                                        "https://expired.example.com"
                                    else
                                        "https://expired.badssl.com")
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1)
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                assertThat("Load should fail", success, equalTo(false))
            }

            @AssertCalled(false)
            override fun onSecurityChange(session: GeckoSession,
                                          securityInfo: GeckoSession.ProgressDelegate.SecurityInformation) {
            }
        })
    }

    val errorEpsilon = 0.1

    private fun waitForScroll(offset: Double, timeout: Double, param: String) {
        mainSession.evaluateJS("""
           new Promise((resolve, reject) => {
             const start = Date.now();
             function step() {
               if (window.visualViewport.$param >= ($offset - $errorEpsilon)) {
                 resolve();
               } else if ($timeout < (Date.now() - start)) {
                 reject();
               } else {
                 window.requestAnimationFrame(step);
               }
             }
             window.requestAnimationFrame(step);
           });
        """.trimIndent())
    }

    private fun waitForVerticalScroll(offset: Double, timeout: Double) {
        waitForScroll(offset, timeout, "pageTop")
    }

    @Ignore // Bug 1547849
    @WithDisplay(width = 400, height = 400)
    @Test fun saveAndRestoreState() {
        sessionRule.setPrefsUntilTestEnd(mapOf("dom.visualviewport.enabled" to true))

        val startUri = createTestUrl(SAVE_STATE_PATH)
        mainSession.loadUri(startUri)
        sessionRule.waitForPageStop()

        mainSession.evaluateJS("document.querySelector('#name').value = 'the name';")
        mainSession.evaluateJS("document.querySelector('#name').dispatchEvent(new Event('input'));")

        mainSession.evaluateJS("window.scrollBy(0, 100);")
        waitForVerticalScroll(100.0, sessionRule.env.defaultTimeoutMillis.toDouble())

        var savedState : GeckoSession.SessionState? = null
        sessionRule.waitUntilCalled(object : Callbacks.ProgressDelegate {
            @AssertCalled(count=1)
            override fun onSessionStateChange(session: GeckoSession, state: GeckoSession.SessionState) {
                savedState = state

                val serialized = state.toString()
                val deserialized = GeckoSession.SessionState.fromString(serialized)
                assertThat("Deserialized session state should match", deserialized, equalTo(state))
            }
        })

        assertThat("State should not be null", savedState, notNullValue())

        mainSession.loadUri("about:blank")
        sessionRule.waitForPageStop()

        mainSession.restoreState(savedState!!)
        sessionRule.waitForPageStop()

        sessionRule.forCallbacksDuringWait(object : Callbacks.NavigationDelegate {
            @AssertCalled
            override fun onLocationChange(session: GeckoSession, url: String?) {
                assertThat("URI should match", url, equalTo(startUri))
            }
        })

        /* TODO: Reenable when we have a workaround for ContentSessionStore not
                 saving in response to JS-driven formdata changes.
        assertThat("'name' field should match",
                mainSession.evaluateJS("$('#name').value").toString(),
                equalTo("the name"))*/

        assertThat("Scroll position should match",
                mainSession.evaluateJS("window.visualViewport.pageTop") as Double,
                closeTo(100.0, .5))

    }

    @WithDisplay(width = 400, height = 400)
    @Test fun flushSessionState() {
        sessionRule.setPrefsUntilTestEnd(mapOf("dom.visualviewport.enabled" to true))

        val startUri = createTestUrl(SAVE_STATE_PATH)
        mainSession.loadUri(startUri)
        sessionRule.waitForPageStop()

        var oldState : GeckoSession.SessionState? = null

        sessionRule.waitUntilCalled(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1)
            override fun onSessionStateChange(session: GeckoSession, sessionState: GeckoSession.SessionState) {
                oldState = sessionState
            }
        })

        assertThat("State should not be null", oldState, notNullValue())

        mainSession.setActive(false)

        sessionRule.waitUntilCalled(object : Callbacks.ProgressDelegate {
            @AssertCalled(count = 1)
            override fun onSessionStateChange(session: GeckoSession, sessionState: GeckoSession.SessionState) {
                assertThat("Old session state and new should match", sessionState, equalTo(oldState))
            }
        })
    }
}
