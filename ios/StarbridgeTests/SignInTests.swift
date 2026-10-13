import XCTest
@testable import Starbridge

final class SignInTests: XCTestCase {
    func testChallengeIsRFC7636S256() {
        // RFC 7636, appendix B.
        XCTAssertEqual(SignIn.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testNonceHashIsSHA256InLowercaseHex() {
        // The server compares Apple's nonce claim with this form (PROTOCOL.md, "Auth").
        XCTAssertEqual(SignIn.nonceHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testVerifierIs43Base64urlCharacters() {
        let v = SignIn.newVerifier()
        XCTAssertEqual(v.count, 43)
        XCTAssertTrue(v.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        XCTAssertNotEqual(v, SignIn.newVerifier())
    }

    func testRedirectReadsTheAppSchemeAndTheHostedPages() throws {
        for link in [
            "starbridge://auth?code=c1&state=s1",
            "https://starbridge.run/app/auth?code=c1&state=s1",
            "https://starbridge.run/v1/auth/github/callback/app?code=c1&state=s1",
        ] {
            XCTAssertEqual(SignIn.redirect(try XCTUnwrap(URL(string: link))), .code("c1", state: "s1"), link)
        }
        XCTAssertEqual(SignIn.redirect(try XCTUnwrap(URL(string: "starbridge://auth?error=access_denied&state=s1"))), .denied(state: "s1"))
    }

    func testRedirectIgnoresOtherLinks() throws {
        for link in [
            "starbridge://pair?server=x&k=y#code",
            "starbridge://auth?code=c1",
            "starbridge://auth?code=&state=s1",
            "https://evil.example/app/auth?code=c1&state=s1",
            "https://starbridge.run/v1/auth/github/callback?code=c1&state=s1",
            "http://starbridge.run/app/auth?code=c1&state=s1",
        ] {
            XCTAssertNil(SignIn.redirect(try XCTUnwrap(URL(string: link))), link)
        }
    }

    func testOnlyStarbridgeRunEndsOnTheHttpsCallback() {
        let https = SignIn.httpsCallback(server: "https://starbridge.run")
        XCTAssertEqual(https?.host, "starbridge.run")
        XCTAssertEqual(https?.path, "/v1/auth/github/callback/app")
        // The app is not in a self-hosted server's apple-app-site-association.
        for server in ["https://sb.example.com", "http://starbridge.run", "https://starbridge.run:8443", "https://starbridge.run.example.com", "http://localhost:18731"] {
            XCTAssertNil(SignIn.httpsCallback(server: server), server)
        }
    }
}
