function pj(text) {
    return JSON.parse(text);
}

async function wait(ms) {
    await new Promise(function(r) {
        setTimeout(r, ms);
    });
}

function Connection(id, userType, user) {
    this.id = id.toUpperCase();
    this.userType = userType.toUpperCase();
    this.user = user;

    for(const [key, value] of Object.entries(Connection.readyStates)) {
        this[key] = value;
    }

    this.readyState = this.NOT_STARTED;

    this.createMessageListener();
}

Connection.readyStates = {
    NOT_STARTED: 0,
    CONNECTING: 1,
    CONNECTED: 2,
    CLOSED: 3
};

Connection.wsStartOnmessage = function(e, ws, resolve, reject) {
    var connection = this;
    var data = pj(e.data);

    if(typeof data !== "object") {
        reject(new TypeError("Received JSON is not type of 'object'"));
        ws.onmessage = null;
        
        return;
    }

    if(data.name !== "Session Entered") {
        reject(new TypeError("Received JSON data.name is not 'Session Entered'"));
        ws.onmessage = null;
        
        return;
    }

    this.readyState = this.CONNECTED;
    
    ws.onmessage = this.createMessageListener(this.onmessage);
    ws.onclose = this.createCloseListener(this.onclose);
    
    ws.onerror = ws.onclose;

    resolve(data.payload);
};

Connection.prototype.sendJSON = function(obj) {
    this.ws.send(JSON.stringify(obj));
};

Connection.prototype.respondHeartbeat = function(data) {
    var { payload } = data;

    this.sendJSON({
        name: "Heartbeat",
        payload: {
            sent: payload.sent,
            received: Date.now()
        }
    });
};

Connection.prototype.createMessageListener = function(func) {
    var connection = this;
    
    return function(e) {
        var data = pj(e.data);

        if(data.name === "Session Changed" && func) {
            func(data);
        } else if(data.name === "Heartbeat") {
            connection.respondHeartbeat(data);
        }
    };
};

Connection.prototype.createCloseListener = function(func) {
    var connection = this;

    return function(e) {
        connection.readyState = connection.CLOSED;

        if(func) func(e);
    };
};

Connection.prototype.start = function() {
    var ws = new WebSocket("wss://session.voxpop.run/" + this.id + "/" + this.userType + "/" + this.user + "?force=true");

    this.ws = ws;
    this.readyState = this.CONNECTING;

    var resolve;
    var reject;
    
    var promise = new Promise(function(res, rej) {
        resolve = res;
        reject = rej;
    });

    var connection = this;

    ws.onmessage = function(e) {
        try {
            Connection.wsStartOnmessage.call(connection, e, ws, resolve, reject);
        } catch(err) {
            reject(err);
        }
    };

    ws.onclose = function() {
        connection.readyState = connection.CLOSED;
        reject(new Error("Connection closed."));
    };

    ws.onerror = function() {
        connection.readyState = connection.CLOSED;
        reject(new Error("Connection error."));
    };

    return promise;
};

Connection.prototype.setReceiveListener = function(func) {
    this.onmessage = func;

    if(this.readyState === this.CONNECTED) {
        this.ws.onmessage = this.createMessageListener(this.onmessage);
    }
};

Connection.prototype.setCloseListener = function(func) {
    this.onclose = func;

    if(this.readyState === this.CONNECTED) {
        this.ws.onclose = this.createCloseListener(this.onclose);
    }
};

Connection.prototype.change = function(change) {
    this.sendJSON({
        name: "Session Change",
        payload: {
            sessionId: this.id,
            change: [change]
        }
    });
};

Connection.prototype.close = function() {
    this.ws.close();
};

// Start

function readFileDU(file) {
    var fr = new FileReader();

    var resolve;
    var promise = new Promise(function(r) {
        resolve = r;
    });

    fr.onload = function() {
        resolve(fr.result);
    };

    fr.readAsDataURL(file);

    return promise;
};

async function createSession(appId, scenarioId, name) {
    var response = await fetch("https://api.voxpop.run/create", {
        method: "POST",
        body: new URLSearchParams({
            app: appId,
            scenarioId,
            name
        })
    });

    if(!response.ok) throw new Error("Not ok.");

    var json = await response.json();
    
    if(!json.success) throw new Error("No success.");

    var { value } = json;

    return {
        appId: value.appId,
        id: value.id,
        isActive: value.isActive,
        name: value.name,
        scenarioId: value.scenarioId,
        scenarioName: value.scenarioName,
        teacherUser: value.users[0],
        version: value.version
    };
}

function randN(min, max) {
    return min + Math.round(Math.random() * max - min);
}

async function store(data) {
    var session = await createSession("sup", "sup-brewer", "Period " + randN(1, 10));
    var connection = new Connection(session.id, "A", session.teacherUser);
    await connection.start();

    connection.change({
        op: "replace",
        path: "/scenario/data",
        value: data
    });

    var connection2 = new Connection(session.id, "A", session.teacherUser);
    await connection2.start();

    connection2.close();

    return {
        id: session.id,
        teacherUser: session.teacherUser
    };
}

async function get(id, teacherUser) {
    var connection = new Connection(id, "A", teacherUser);

    var session = (await connection.start()).scenario.data;
    connection.close();

    return session;
}

async function storeFile(file, { maxChunkSize, maxThreads }, onprogress) {
    var dataURL = await readFileDU(file);

    var mimeType = dataURL.split(":")[1].split(";")[0];
    var b64Data = dataURL.split(",")[1];

    var dataChunks = [];

    for(let i = 0; i < b64Data.length; i += maxChunkSize) {
        dataChunks.push(b64Data.slice(i, i + maxChunkSize));
    }

    // Store chunks

    var chunkLocations = [];

    for(let i = 0; i < dataChunks.length; i++) {
        let chunk = dataChunks[i];

        chunkLocations.push(await store({
            type: "chunk",
            data: chunk
        }));

        if(onprogress) onprogress(i + 1, dataChunks.length);
    }

    console.log(chunkLocations);

    // Store metadata

    var metaSession = await store({
        type: "meta",
        data: {
            filename: file.name,
            mimeType,
            chunkLocations
        }
    });

    return metaSession;
}

async function getFile(id, teacherUser, onprogress) {
    var metadata = await get(id, teacherUser);

    if(metadata.type !== "meta") throw new TypeError("Type 'meta' not found in metadata. Instead got '" + metadata.type + "'")

    var { filename, mimeType, chunkLocations } = metadata.data;

    var chunks = [];

    for(let i = 0; i < chunkLocations.length; i++) {
        let location = chunkLocations[i];
        let { id, teacherUser } = location;

        chunks.push((await get(id, teacherUser)).data);

        if(onprogress) onprogress(i + 1, chunkLocations.length);
    }

    var data = chunks.join("");

    return data;
}

// Do it!

var input = document.createElement("input");
input.type = "file";

input.style.position = "fixed";
input.style.top = "0px";
input.style.left = "0px";
input.style.backgroundColor = "lightblue";
input.style.width = "500px";
input.style.height = "350px";

document.body.appendChild(input);

var config = {
    maxChunkSize: 75000,
    maxThreads: 25
};

input.oninput = async function() {
    input.disabled = true;

    var file = input.files[0];

    var session = await storeFile(file, config, function(current, max) {
        console.log("Progress: " + (current / max * 100) + "%");
    });

    console.log("download(\"" + session.id + "\", \"" + session.teacherUser + "\");")

    input.disabled = false;
};

async function download(a, b) {
    return await getFile(a, b, function(current, max) {
        console.log("Progress: " + (current / max * 100) + "%");
    });
}
