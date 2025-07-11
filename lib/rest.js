let fetch = require('node-fetch');
require('dotenv').config();
let endpoints = require('./endpoints');
let ErrorHandler = require('./errorHandling');


function restAPI(connection,logError){

    let restEndpoint = endpoints(connection).restApi;

    async function getSObjectsDescribe(){

        let request = `${connection.url}${restEndpoint}sobjects/`; 
        let options = getFetchOptions(connection.token);
        let json;

        try {
            let res = await fetch(request,options);
            json = await res.json();

        } catch (error) {
            //if one report throws an error here, we can move on to the next
            //one because this is not critical functionality
            logError(`REST API call failed`,{request,error});
        }
    
        return json.sobjects;

    }

    async function query(soqlQuery){

        let jsonResponse;
        let endpoint = restEndpoint;

        if(soqlQuery.useToolingApi){
            endpoint += `tooling/`;
        }

        if(soqlQuery.apiVersionOverride){
            let versionEndpoint = overrideApiVersion(endpoint,soqlQuery.apiVersionOverride);
            endpoint = connection.url+versionEndpoint;
        }
        else{
            endpoint = connection.url+endpoint;
        }

        endpoint += `query/?q=`;

        let request = endpoint+encodeURIComponent(soqlQuery.query); 
        let options = getFetchOptions(connection.token);    

        if(soqlQuery.filterById && tooManyIds(soqlQuery.query)){
            jsonResponse = await tryWithSmallerQueries(soqlQuery.query,endpoint,options);
        }

        else{

            let res = await fetch(request,options);
        
            if(!res.ok){
                
                if(hitRequestSizeLimit(res)){
                    jsonResponse = await tryWithSmallerQueries(soqlQuery.query,endpoint,options);
                }

                else {
                    jsonResponse = await res.json();

                    //we throw the error but don't log it, let the caller deal with it. This is to prevent our logs
                    //to be flooded with these errors
                    if(isAccessError(jsonResponse) || isInvalidFieldError(jsonResponse)){
                        throw new ErrorHandler(res.status,res.statusText,'Fetch failed on Tooling API query',jsonResponse?.[0]?.message);
                    }
                    else{
                        //other type of errors should be logged and thrown
                        logError(`Tooling API call failed`,{request,jsonResponse});
                        throw new ErrorHandler(res.status,res.statusText,'Fetch failed on Tooling API query',jsonResponse?.[0]?.message);
                    }
                }
            }

            else{

                jsonResponse = await res.json();

                if(isFailedResponse(jsonResponse)){
                    logError(`Tooling API call failed`,{request,jsonResponse});
                    throw createApiError(jsonResponse);
                }
    
                if(!jsonResponse.done){
                    let queryMoreRequest = getQueryMoreRequest();
                    await queryMoreRequest.exec(jsonResponse.nextRecordsUrl,connection,options);
                    jsonResponse.records.push(...queryMoreRequest.getRecords());
                }
            }  
        }

        return jsonResponse;
    }

    async function readMetadata(metadata){

        let endpoint = `${connection.url}${restEndpoint}tooling`;

        let subRequests = metadata.map(md => { 

            let request = { 
                method:'GET',
                url:`${restEndpoint}tooling/sobjects/${md.type}/${md.id}`, 
                referenceId:md.id 
            }
            return request;
        });

        //max number of subrequest per composite request
        let batches = splitInBatchesOf(subRequests,25);

        let compositeRequests = batches.map(batch => {

            let compositeRequestBody = {
                allOrNone:false,
                compositeRequest:batch
            }
            return compositeRequestBody;
        })

        let compositeEndpoint = `${endpoint}/composite`

        let data = await Promise.all(

            compositeRequests.map(async (request) => {

                let fetchOptions = getFetchOptions(connection.token,'POST');
                fetchOptions.body = JSON.stringify(request);

                try {

                    let res = await fetch(compositeEndpoint,fetchOptions);
                    let json = await res.json();

                    return json;

                } catch (error) {
                    //do nothing, we'll process the other requests, this is a partial success operation
                }
            })
        )

        let metadataByType = new Map();

        data.forEach(composite => {

            composite.compositeResponse.forEach(response => {

                if(response.httpStatusCode == 200){

                    let {body} = response;
                    let type = body.attributes.type;
                    
                    if(metadataByType.has(type)){
                        metadataByType.get(type).push(body);
                    }
                    else{
                        metadataByType.set(type,[body]);
                    }
                }
            })  
        })

        return metadataByType;
    }

    return {getSObjectsDescribe,query,readMetadata}

}

function getFetchOptions(token,method = 'GET'){
    return {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
    }
}

function createApiError(jsonResponse){
    let apiError = new Error();
    apiError.statusCode = 404;
    apiError.name = 'no-sfdc-connection';
    apiError.message = jsonResponse[0].message;
    return apiError;
}



function getQueryMoreRequest(){

    let records = [];

    async function exec(nextRecordsUrl,connection,fechOptions){

        let endpoint = connection.url+nextRecordsUrl;
        let res = await fetch(endpoint,fechOptions);

        if(!res.ok){            
            throw new ErrorHandler(res.status,res.statusText,'Fetch failed on Tooling API query');
        }

        let jsonResponse = await res.json();

        if(isFailedResponse(jsonResponse)){
            throw createApiError(jsonResponse);
        }

        records.push(...jsonResponse.records);

        if(!jsonResponse.done){
            await exec(jsonResponse.nextRecordsUrl,connection,fechOptions);
        }
    }

    function getRecords(){
        return records;
    }

    return {exec,getRecords};
}

function tooManyIds(queryString){
    let allIds = getIds(queryString);
    return (allIds.length > 300);
}

function hitRequestSizeLimit(res){

    let tooLargeReponseValues = ['Request Header Fields Too Large','URI Too Long'];
    let tooLargeStatusCodes = ['414','431'];

    return (tooLargeReponseValues.includes(res.statusText) || tooLargeStatusCodes.includes(res.status));

}

async function tryWithSmallerQueries(queryString,endpoint,options){

    let allIds = getIds(queryString);
    let batches = splitInBatchesOf(allIds,100);

    let queryParts = getSOQLWithoutIds(queryString);
    let [selectClause,afterFilters] = queryParts;

    let smallerQueries = batches.map(batch => {

        let ids = batch.join(',');
        let query = `${selectClause} (${ids}) ${afterFilters}`;
        return query;

    });

    let data = await Promise.all(

        smallerQueries.map(async (smallQuery) => {

            let request = endpoint+encodeURIComponent(smallQuery);  
            
            let res = await fetch(request,options);

            if(res.ok){

                let json = await res.json();

                if(isFailedResponse(json)){
                    throw createApiError(json);
                    
                }
                else{
                    return json;
                }

            }else{
                throw new ErrorHandler(res.status,res.statusText,'Fetch failed on Tooling API query');
            }
        })
    );

    let response = {};
    response.records = [];

    data.map(d => {
        response.records.push(...d.records);
    });

    return response;

}

function getIds(queryString){

    let startParenthesis = queryString.indexOf('(');
    let endParenthesis = queryString.indexOf(')');

    let idFilter = queryString.substring(startParenthesis+1,endParenthesis);

    let ids = idFilter.split(',');

    return ids;
}

function getSOQLWithoutIds(queryString){

    let startParenthesis = queryString.indexOf('(');
    let endParenthesis = queryString.indexOf(')');

    let selectClause = queryString.substring(0,startParenthesis);
    let afterFilters = queryString.substring(endParenthesis+1);

    let parts = [selectClause,afterFilters];

    return parts;
}


//when querying email templates or reports, it's possible for these items to be in a private
//folder that the running user doesn't have access to, here we inspect the error and determine
//if it's indeed this kind of error
//the caller will then decide if this error needs a specific action
function isAccessError(jsonResponse){

    if(Array.isArray(jsonResponse) && jsonResponse[0] && jsonResponse[0] == `Cannot retrieve documents in a user's private folder; move the document to a named folder`){
        return true;
    }

    return false;
}

//when querying certain fields dynamically, sometimes we get long text area fields which cannot be filtered
//in a soql query. We ignore this error and continue to query other records
function isInvalidFieldError(jsonResponse){

    if(Array.isArray(jsonResponse) && jsonResponse[0] && jsonResponse[0].message.includes('can not be filtered in a query call')){
        return true;
    }

    return false;
}

function isFailedResponse(json){

    if(json[0] && json[0]['errorCode']){
        return true;
    }
    return false;
}

/**
 * Sometimes the client needs to be able to specify the API version, for example when querying fields that only exists in certain
 * versions of the API (for example the TableEnumOrId is only available in version 33.0 for the ValidationRule object)
 */
function overrideApiVersion(endpoint,newVersion){

    let apiPath = endpoint.indexOf('/v');
    let apiPathLength = 7; //>> /v45.0/

    let start = endpoint.substring(0,apiPath);
    let end = endpoint.substring(apiPath+apiPathLength,endpoint.length);

    let newApiPath = `/v${newVersion}/`;

    let newEndpoint = start+newApiPath+end;

    return newEndpoint;
}

function splitInBatchesOf(items,batchSize){

    let remainingItems = items.length;
    let indexSoFar = 0;
    let batches = [];

    while (remainingItems > batchSize) {
        
        let batch = [];

        for (let x = 0; x < batchSize; x++,indexSoFar++) {
            batch.push(items[indexSoFar]);       
        }

        batches.push(batch);
        remainingItems -= batchSize;
    }

    if(remainingItems > 0) batches.push(items.slice(indexSoFar));

    return batches;

}

module.exports = restAPI;