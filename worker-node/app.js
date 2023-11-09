import { connect, keyStores, Contract, utils } from 'near-api-js';
import axios from 'axios';
import decompress from 'decompress';
import { PythonShell } from 'python-shell';
import fs from 'fs';
import { create } from 'ipfs-http-client';
import { exec } from 'child_process';
import { env } from 'process';

const projectId = "2Xv5JJtzWWVdnZnA6ZMg9wo6Uif";
const projectSecret = "b9752e5f1a396a1c3ba2277951427b10";

const auth = 'Basic ' + Buffer.from(projectId + ':' + projectSecret).toString('base64');
const ipfs = create({ host: 'ipfs.infura.io', port: 5001, protocol: 'https', headers: { authorization: auth }});

const home_dir = env.HOME;
const keyStore = new keyStores.UnencryptedFileSystemKeyStore(`${home_dir}/.near-credentials`);
const nearConfig = {
  networkId: 'testnet',
  keyStore: keyStore,
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://wallet.testnet.near.org',
  contractName: 'obrigado.testnet',
};

// Function to download and extract the workspace
async function downloadAndPrepareWorkspace(url, taskId) {
  const workspaceDir = `${process.cwd()}/workspaces/${taskId}`;
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  console.log("PROCESSING TASK MADAFAKAAAAAA");
  console.log(url);
  console.log(taskId);

  const response = await axios({ url, responseType: 'arraybuffer' });
  await decompress(response.data, workspaceDir);

  prepareWorkspace(workspaceDir)

  return workspaceDir;
}

async function prepareWorkspace(workspaceDir) {
  // Create a Python virtual environment
  
  const command = `cd ${workspaceDir} && python3 -m venv venv`;
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
      return;
    }
    console.log(`Stdout: ${stdout}`);
  });

  // Install dependencies from requirements.txt
  const command2 = `cd ${workspaceDir} && ./venv/bin/pip install -r requirements.txt`;
  exec(command2, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
      return;
    }
    console.log(`Stdout: ${stdout}`);
  });
}

// Function to execute the Python script
function executePythonScript(workspaceDir, entryScript) {
    const command = `cd ${workspaceDir} && . venv/bin/activate && python ${entryScript}`;
    exec(command, (error, stdout, stderr) => {
        if (error) {
        console.error(`Error: ${error.message}`);
        return;
        }
        if (stderr) {
        console.error(`Stderr: ${stderr}`);
        return;
        }
        console.log(`Stdout: ${stdout}`);
    });
  }

// Function to upload results to IPFS
async function uploadResultsToIPFS(workspaceDir) {
  const resultsDir = `${workspaceDir}/results`;
  // Zip the results directory
  const command2 = `cd ${resultsDir} && zip -r results.zip .`;
  exec(command2, (error, stdout, stderr) => {
      if (error) {
      console.error(`Error: ${error.message}`);
      return;
      }
      if (stderr) {
      console.error(`Stderr: ${stderr}`);
      return;
      }
      console.log(`Stdout: ${stdout}`);
  });

  // Read the zipped file
  const file = fs.readFileSync(`${resultsDir}/results.zip`);
  const added = await ipfs.add(file);
  const url = `https://ipfs.infura.io/ipfs/${added.path}`;
  const hash = added.cid.toString();

  return { url, hash };
}

// Function to submit the result to the smart contract
async function submitResultToContract(contract, taskId, resultUrl, resultHash) {
    await contract.submit_result({ task_id: taskId, result_hash: resultHash, result_url: resultUrl });
}

// Function to process a task
async function processTask(contract, task) {
  try {
    const workspaceDir = await downloadAndPrepareWorkspace(task.repository_url, task.id);
    executePythonScript(workspaceDir, 'main.py');
    const { url, hash } = await uploadResultsToIPFS(workspaceDir);
    await submitResultToContract(contract, task.id, url, hash);
  } catch (error) {
    console.error('Error processing task:', error);
  }
}

// Main function to listen to the job queue and process tasks
async function listenToJobQueue() {

    // // while developing hardcode running the job from the local path
    // const job_workspace_dir = "../sample_jobs/hellonear/"

    // // create python venv and install requirements
    // await prepareWorkspace(job_workspace_dir)
    // await executePythonScript(job_workspace_dir, 'entry_script.py')
    // .then((output) => {
    //     // Output has already been logged to the console in the function
    //     // TODO: store it in a file, upload it and submit the results
    //     console.log(output)
    //   })
    //   .catch((error) => {
    //     // Error has already been logged to the console in the function
    //     // TODO: store it in a file, upload it and submit the results
    //     console.log(error)
    //   });

    // TODO: uncomment below to actually listen to the queue
    // TODO: add the changes above to cetch the console logs and package them

    let accountId = null;
    // Loop through the arguments
    process.argv.forEach((val, index) => {
    // Check if the argument is 'accountId'
    if (val.startsWith('--accountId=')) {
        accountId = val.split('=')[1];
    }
    });
    const near = await connect(nearConfig);
    const wallet = await near.account(accountId);
    const contract = new Contract(wallet, nearConfig.contractName, { //nearConfig.contractName
        viewMethods: ['get_tasks_from_queue'],
        changeMethods: ['submit_result'],
        // the sender is the worker, also the bounty hunter 
        sender: accountId,
    });


    // {
    //   submitter_account_id: 'develoco.testnet',
    //   bounty: 21,
    //   repository_url: 'asdasdasd',
    //   confirmation_count: '0',
    //   confirmations: {},
    //   id: 'cmawozD4CwTh',
    //   task_queue_timestamp_key: '1699480703646659420-develoco.testnet',
    //   timestamp: '1699480703646659420'
    // },

    let isJobRunning = false;

    const processTasks = async () => {
        if (isJobRunning) {
            console.log("Running task exists, skipping the fetch...");
            scheduleNextCheck();
            return;
        }

        isJobRunning = true;
        console.log("No running tasks, fetching the task queue...");

        try {
            const tasks = await contract.get_tasks_from_queue({});
            // console.log(tasks);

            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                if (!Object.keys(task.confirmations).some(r => r === wallet.accountId)) {
                    console.log("Starting the task execution...");
                    await processTask(contract, task);
                    break; // Exit the loop after one task is processed
                }
            }
        } catch (error) {
            console.error("An error occurred while processing tasks:", error);
        } finally {
            isJobRunning = false;
            scheduleNextCheck(); // Schedule the next check after the current task has been processed or an error has occurred
        }
    };

    const scheduleNextCheck = () => {
        setTimeout(processTasks, 1000); // Schedule the next check after 1 second
    };

    scheduleNextCheck(); // Start the initial

    // // submit_result(&mut self, task_id: String, result_hash: String)
    // // `contract.methodName({ args, gas?, amount?, callbackUrl?, meta? })`
    // const tasks = await contract.submit_result({args: {task_id: '1245678',result_hash: "test-hash"}});
}

listenToJobQueue().then(() => {
  console.log('Job executor is running...');
}).catch(console.error);
