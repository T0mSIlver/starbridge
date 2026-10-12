# Signs in to App Store Connect with the API key that release.yml's testflight job hands to
# xcodebuild, and says what fails before an archive does: the key file's shape, the runner's clock,
# a key App Store Connect refuses (401), a role that may not manage signing (403), and each App
# ID's capabilities. It prints
# the key's public half's SHA-256, never the key, to compare with the .p8 kept offline:
#   openssl pkey -in AuthKey_<id>.p8 -pubout -outform DER | shasum -a 256
# Usage: ruby asc-check.rb <AuthKey_<id>.p8> <key id> <issuer id>
require "base64"
require "json"
require "net/http"
require "openssl"
require "time"

$stdout.sync = true

path, kid, issuer = ARGV
abort "usage: asc-check.rb <p8> <key id> <issuer id>" unless path && kid && issuer
text = File.read(path)
pem = text.include?("-----BEGIN PRIVATE KEY-----") && text.include?("-----END PRIVATE KEY-----")
puts "key file: #{text.lines.count} lines, mode #{format('%o', File.stat(path).mode & 0o777)}, PEM markers #{pem ? 'present' : 'MISSING'}"
puts "literal \\n in the file: the secret was pasted on one line" if text.include?('\n')
key = begin
  OpenSSL::PKey.read(text)
rescue OpenSSL::PKey::PKeyError => e
  abort "the key file is not a private key OpenSSL can read: #{e.class}"
end
abort "the key is #{key.class}, not an EC key" unless key.is_a?(OpenSSL::PKey::EC)
spki = key.respond_to?(:public_to_der) ? key.public_to_der : begin
  pub = OpenSSL::PKey::EC.new(key.group)
  pub.public_key = key.public_key
  pub.to_der
end
puts "public key SHA-256: #{OpenSSL::Digest::SHA256.hexdigest(spki)}"

b64 = ->(s) { Base64.urlsafe_encode64(s).delete("=") }
now = Time.now.to_i
input = [b64.call({ alg: "ES256", kid: kid, typ: "JWT" }.to_json),
         b64.call({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }.to_json)].join(".")
# JWS wants r and s, 32 bytes each, where OpenSSL gives a DER sequence.
der = key.sign(OpenSSL::Digest::SHA256.new, input)
raw = OpenSSL::ASN1.decode(der).value.map { |n| n.value.to_s(2).rjust(32, "\0") }.join
jwt = "#{input}.#{b64.call(raw)}"

failed = false
http = Net::HTTP.new("api.appstoreconnect.apple.com", 443)
http.use_ssl = true
http.start do
  # Apps reads with any role; bundle IDs only with one that may manage signing.
  ["/v1/apps?filter[bundleId]=dev.starbridge.ios&fields[apps]=bundleId",
   "/v1/bundleIds?filter[identifier]=dev.starbridge.ios&fields[bundleIds]=identifier&limit=5"].each do |q|
    res = http.get(q, "Authorization" => "Bearer #{jwt}")
    skew = res["date"] ? (now - Time.httpdate(res["date"]).to_i) : nil
    body = JSON.parse(res.body) rescue {}
    errors = (body["errors"] || []).map { |e| "#{e['code']}: #{e['detail']}" }.join("; ")
    count = (body["data"] || []).map { |d| d.dig("attributes", "bundleId") || d.dig("attributes", "identifier") }.inspect
    puts "GET #{q.split('?').first}: #{res.code} #{errors.empty? ? count : errors}#{skew ? " (runner clock #{skew}s off Apple's)" : ''}"
    failed ||= res.code != "200"
  end
  # What the export's signing starts from: each App ID and its capabilities.
  res = http.get("/v1/bundleIds?filter[identifier]=dev.starbridge.ios,dev.starbridge.ios.notifications" \
                 "&include=bundleIdCapabilities&fields[bundleIdCapabilities]=capabilityType&limit=10",
                 "Authorization" => "Bearer #{jwt}")
  if res.code == "200"
    body = JSON.parse(res.body)
    types = (body["included"] || []).map { |c| [c["id"], c.dig("attributes", "capabilityType")] }.to_h
    (body["data"] || []).each do |d|
      caps = (d.dig("relationships", "bundleIdCapabilities", "data") || []).map { |c| types[c["id"]] }.compact.sort
      puts "App ID #{d.dig('attributes', 'identifier')}: #{caps.join(', ')}"
    end
  end
end
exit(failed ? 1 : 0)
