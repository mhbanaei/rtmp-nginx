from flask import Flask, request
 
 app = Flask(__name__)
 
 # Tarif Data name va valid Stream Key 
 VALID_KEYS = {
     "live1": ["key1_live1", "key2_live1"],
     "live2": ["key1_live2", "key2_live2"],
     "live3": ["key1_live3", "key2_live3"]
 }
 
 @app.route("/auth", methods=["POST"])
 def auth():
     server = request.args.get("server", "")  # Server name based on Query String
     stream_key = request.form.get("name", "")  # Streamkey Form Data
 
     if server in VALID_KEYS and stream_key in VALID_KEYS[server]:
         print(f"✅ Access granted to {server} with key {stream_key}")
         return "OK", 200  # Mojaz Be Stream
     else:
         print(f"❌ Access denied for {server} with key {stream_key}")
         return "Forbidden", 403  # Decline Kardan Stream 
 
 if __name__ == "__main__":
     app.run(host="0.0.0.0", port=8000)