# Signing for the App Store through App Store Connect's REST API (#1419), since xcodebuild's own
# sign-in refuses the API key that the REST API takes. `prepare` makes sure both App IDs exist with
# their capabilities, creates an Apple Distribution certificate from a key made here, and an App
# Store profile per App ID, then writes into <dir> the key, the certificate, the profiles and the
# export options. `cleanup` revokes that certificate and deletes those profiles: each run makes
# its own and keeps nothing, so no certificate is stored to leak or rotate, and builds already
# uploaded stay valid, since the App Store re-signs them. It never prints a key or a token.
# Usage: ruby asc-signing.rb prepare|cleanup <dir>, with ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID.
require "fileutils"
require_relative "asc"

$stdout.sync = true

TEAM = "3N63N7U9R3".freeze
GROUP = "group.dev.starbridge.ios".freeze
APP_IDS = {
  "dev.starbridge.ios" => { name: "Starbridge", caps: %w[PUSH_NOTIFICATIONS APP_GROUPS ASSOCIATED_DOMAINS] },
  "dev.starbridge.ios.notifications" => { name: "Starbridge notifications", caps: %w[APP_GROUPS] },
}.freeze

command, dir = ARGV
abort "usage: asc-signing.rb prepare|cleanup <dir>" unless %w[prepare cleanup].include?(command) && dir
asc = Asc.new(ENV.fetch("ASC_KEY_PATH"), ENV.fetch("ASC_KEY_ID"), ENV.fetch("ASC_ISSUER_ID"))
state_path = File.join(dir, "state.json")

def call(asc, method, path, body = nil, ok: [200, 201, 204])
  code, res = asc.request(method, path, body)
  abort "#{method} #{path.split('?').first}: #{code} #{Asc.errors(res)}" unless ok.include?(code)
  res
end

def data(type, attributes, relationships = nil)
  d = { type: type, attributes: attributes }
  d[:relationships] = relationships if relationships
  { data: d }
end

if command == "cleanup"
  exit 0 unless File.exist?(state_path)
  state = JSON.parse(File.read(state_path))
  failed = false
  (state["profiles"] || []).each do |p|
    code, res = asc.request("DELETE", "/v1/profiles/#{p['id']}")
    next if [204, 404].include?(code)
    puts "::warning::profile #{p['name']} not deleted: #{code} #{Asc.errors(res)}"
    failed = true
  end
  if (id = state["certificate"])
    code, res = asc.request("DELETE", "/v1/certificates/#{id}")
    unless [204, 404].include?(code)
      puts "::warning::certificate #{id} not revoked: #{code} #{Asc.errors(res)}; revoke it in Certificates, Identifiers & Profiles"
      failed = true
    end
  end
  puts "revoked the certificate and deleted #{(state['profiles'] || []).size} profiles" unless failed
  exit(failed ? 1 : 0)
end

FileUtils.mkdir_p(dir, mode: 0o700)
state = { "profiles" => [] }
save = -> { File.write(state_path, JSON.generate(state)) }

# The App IDs and their capabilities. The filter also matches longer identifiers, so each is
# compared whole.
found = call(asc, "GET", "/v1/bundleIds?filter[identifier]=#{APP_IDS.keys.join(',')}&filter[platform]=IOS" \
                         "&include=bundleIdCapabilities&fields[bundleIdCapabilities]=capabilityType&limit=50")
types = (found["included"] || []).map { |c| [c["id"], c.dig("attributes", "capabilityType")] }.to_h
ids = {}
APP_IDS.each do |identifier, spec|
  row = (found["data"] || []).find { |d| d.dig("attributes", "identifier") == identifier }
  if row
    have = (row.dig("relationships", "bundleIdCapabilities", "data") || []).map { |c| types[c["id"]] }
  else
    row = call(asc, "POST", "/v1/bundleIds",
               data("bundleIds", { identifier: identifier, name: spec[:name], platform: "IOS" }))["data"]
    puts "registered App ID #{identifier}"
    have = []
  end
  ids[identifier] = row["id"]
  (spec[:caps] - have).each do |cap|
    call(asc, "POST", "/v1/bundleIdCapabilities",
         data("bundleIdCapabilities", { capabilityType: cap },
              { bundleId: { data: { type: "bundleIds", id: row["id"] } } }))
    puts "enabled #{cap} on #{identifier}"
  end
end

# A key made here, its certificate signed by Apple. Apple Distribution certificates take RSA 2048.
key = OpenSSL::PKey::RSA.new(2048)
csr = OpenSSL::X509::Request.new
csr.version = 0
csr.subject = OpenSSL::X509::Name.new([["CN", "Starbridge CI"], ["O", TEAM]])
csr.public_key = key
csr.sign(key, OpenSSL::Digest::SHA256.new)
cert = call(asc, "POST", "/v1/certificates",
            data("certificates", { certificateType: "DISTRIBUTION", csrContent: csr.to_pem }))["data"]
state["certificate"] = cert["id"]
save.call
File.open(File.join(dir, "distribution.key"), "w", 0o600) { |f| f.write(key.to_pem) }
File.binwrite(File.join(dir, "distribution.cer"), Base64.decode64(cert.dig("attributes", "certificateContent")))
puts "created Apple Distribution certificate #{cert['id']}, expires #{cert.dig('attributes', 'expirationDate')}"

run = "#{ENV.fetch('GITHUB_RUN_ID', Time.now.to_i)}-#{ENV.fetch('GITHUB_RUN_ATTEMPT', 1)}"
profiles = {}
ids.each do |identifier, id|
  name = "Starbridge CI #{run} #{identifier}"
  profile = call(asc, "POST", "/v1/profiles",
                 data("profiles", { name: name, profileType: "IOS_APP_STORE" },
                      { bundleId: { data: { type: "bundleIds", id: id } },
                        certificates: { data: [{ type: "certificates", id: cert["id"] }] } }))["data"]
  state["profiles"] << { "id" => profile["id"], "name" => name }
  save.call
  content = Base64.decode64(profile.dig("attributes", "profileContent"))
  File.binwrite(File.join(dir, "#{profile.dig('attributes', 'uuid')}.mobileprovision"), content)
  profiles[identifier] = name
  # The profile is a signed plist; its entitlements are what the app may claim.
  plist = content[/<\?xml.*<\/plist>/m].to_s
  groups = plist[%r{<key>com\.apple\.security\.application-groups</key>\s*<array>(.*?)</array>}m, 1].to_s
  next if groups.include?(GROUP)
  abort "the #{identifier} profile lacks the app group #{GROUP}. In Certificates, Identifiers & Profiles, " \
        "register the App Group #{GROUP} (Identifiers, App Groups), then on App IDs dev.starbridge.ios and " \
        "dev.starbridge.ios.notifications, App Groups, Configure, select it, and run again."
end

entries = profiles.map { |b, n| "<key>#{b}</key><string>#{n}</string>" }.join
File.write(File.join(dir, "ExportOptions.plist"), <<~PLIST)
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>method</key><string>app-store-connect</string>
    <key>destination</key><string>export</string>
    <key>signingStyle</key><string>manual</string>
    <key>signingCertificate</key><string>Apple Distribution</string>
    <key>teamID</key><string>#{TEAM}</string>
    <key>provisioningProfiles</key><dict>#{entries}</dict>
    <key>manageAppVersionAndBuildNumber</key><false/>
    <key>uploadSymbols</key><true/>
  </dict></plist>
PLIST
puts "created App Store profiles: #{profiles.values.join(', ')}"
