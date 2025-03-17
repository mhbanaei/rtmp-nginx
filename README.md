# rtmp-nginx
Pushing RTMP data as Restreaming Service 

Requirement Package:

	Microsoft.Visual.C.All.Package
	nginx 1.7.11.3 Gryphon
	http://nginx-win.ecsds.eu/download/

Requirement For auth_server.py
	pip install flask

# Stream Key Validation API
A Flask-based APi to validate stream keys for different servers 

# How It Works 
 Endpoint: POST /auth
 Params:
	server : Server name (query parameter)
	name : Stream Key (form data)
Validates if the stream key matches the one for the specified serve.

# Example 
	Request : POST /auth?server=live1 with name=key1_live1
	Response : 200 OK for valid Key, 403 Forbidden for invalid key.
	
# Running 

Very Simple :
	install the Requirement Package then : 
		py auth_server.py 
# note
	Tested on For Windows Server 2022 