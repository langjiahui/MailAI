// One-time local migration client. Secret input is accepted only on stdin;
// stdout contains an outcome/count, never plaintext or a master key.
import Foundation
import CryptoKit
import Security
import Darwin

func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
let expected = "identifier \"com.langjiahui.mailai.credential-agent.v1\" and certificate leaf = H\"a04567b09e3230ba773b70e6b1343244b387186b\""
guard CommandLine.arguments.count == 3 else { fail("Expected agent and output paths") }
let agent = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
var code: SecStaticCode?; var requirement: SecRequirement?
guard SecStaticCodeCreateWithPath(agent as CFURL, [], &code) == errSecSuccess,
      SecRequirementCreateWithString(expected as CFString, [], &requirement) == errSecSuccess,
      SecStaticCodeCheckValidity(code!, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { fail("Agent identity mismatch") }
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 24 * 1024 * 1024,
      let envelope = try? JSONSerialization.jsonObject(with: input) as? [String: String],
      let encoded = envelope["key"], let key = Data(base64Encoded: encoded), key.count == 32,
      let encodedBlob = envelope["ciphertext"], let blob = Data(base64Encoded: encodedBlob),
      let plaintext = try? AES.GCM.open(AES.GCM.SealedBox(combined: blob.dropFirst("MAILAI-CREDENTIALS2\0".utf8.count)), using: SymmetricKey(data: key), authenticating: Data("MAILAI-CREDENTIALS2\0".utf8)),
      blob.starts(with: Data("MAILAI-CREDENTIALS2\0".utf8)),
      let record = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
      record["version"] as? Int == 1, let items = record["items"] as? [String: String], record["removed"] is [String]
      else { fail("Original encrypted vault did not authenticate") }
guard !FileManager.default.fileExists(atPath: output.path) else { fail("Destination already exists; no replacement performed") }
func query(_ action: String, _ secret: String = "") -> (Int32, String) {
    let task = Process();task.executableURL = agent
    let write = Pipe(), read = Pipe();task.standardInput=write;task.standardOutput=read;task.standardError=FileHandle.nullDevice
    do { try task.run() } catch { fail("Unable to start credential agent") }
    write.fileHandleForWriting.write(Data("\(action)\n0\n\(secret)\n".utf8));try? write.fileHandleForWriting.close()
    let response=read.fileHandleForReading.readDataToEndOfFile();task.waitUntilExit()
    guard task.terminationStatus==0, let text=String(data:response,encoding:.utf8), text.utf8.count<=128 else { fail("Credential agent denied migration") }
    let fields=text.split(separator:"\n",omittingEmptySubsequences:false)
    guard let status=Int32(fields[0]), fields.count>=2 else { fail("Invalid agent response") }
    return(status,String(fields[1]))
}
var (status, master)=query("read")
if status == errSecItemNotFound {
    var random = Data(count:32)
    guard random.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault,32,$0.baseAddress!) })==errSecSuccess else { fail("Random key generation failed") }
    master=random.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_")
    (status,_)=query("add",master)
    if status==errSecDuplicateItem { (status,master)=query("read") }
}
let normalized=master.replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/")
guard status==errSecSuccess, let newKey=Data(base64Encoded:normalized), newKey.count==32 else { fail("Master access requires authorization; no UI was requested") }
do {
    let magic=Data("MAILAI-CREDENTIALS3\0".utf8)
    let sealed=try AES.GCM.seal(plaintext,using:SymmetricKey(data:newKey),authenticating:magic)
    guard let combined=sealed.combined, try AES.GCM.open(AES.GCM.SealedBox(combined:combined),using:SymmetricKey(data:newKey),authenticating:magic)==plaintext else { fail("Encrypted migration verification failed") }
    let temporary=output.deletingLastPathComponent().appendingPathComponent(".credential-migration-"+UUID().uuidString)
    defer { try? FileManager.default.removeItem(at:temporary) }
    let descriptor=open(temporary.path,O_WRONLY|O_CREAT|O_EXCL,0o600)
    guard descriptor>=0 else { fail("Could not create private encrypted output") }
    let handle=FileHandle(fileDescriptor:descriptor,closeOnDealloc:true)
    try handle.write(contentsOf:magic+combined);try handle.synchronize();try handle.close()
    guard link(temporary.path,output.path)==0 else { fail("Destination exists or atomic install failed") }
    print("PASS migrated \(items.count) credential records; original vault retained")
} catch { fail("Could not persist encrypted migration") }
