'use client';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
} from 'viem';
import { useWallets } from '@privy-io/react-auth';
import { useEffect, useCallback, useState } from "react";
import { getChain } from '@/lib/chain';

const FaucetABI = [
  {type:"function",name:"hasClaimed",inputs:[{name:"",type:"address",internalType:"address"}],outputs:[{name:"",type:"bool",internalType:"bool"}],stateMutability:"view"},
  {type:"function",name:"requestTokens",inputs:[],outputs:[],stateMutability:"nonpayable"},
];
const faucetAddress = "0xa73A4155f057d97af0a02972ccB9ca327b29E3D0" 

export default function Faucet({}) {
  const { wallets } = useWallets();
  const [loadingData, setLoadingData] = useState<boolean>(false);
  const [alreadyReq, setAlreadyReq] = useState<boolean>(false);
  const [requesting, setRequesting] = useState<boolean>(false);
  
  const publicClient = createPublicClient({ chain: getChain(), transport: http() });

  const wallet = wallets[0];

  const fetchData = useCallback(async () => {
    setLoadingData(true);
    if (!wallet) return;
    try {
      let account: `0x${string}` | undefined;
      if (wallet) {
        const provider = await wallet.getEthereumProvider();
        [account] = await createWalletClient({ chain: getChain(), transport: custom(provider) }).getAddresses();
      }
      const requested = await publicClient.readContract({ 
        address: faucetAddress, 
        abi: FaucetABI, 
        functionName: 'hasClaimed', 
        args: [account] })
      setAlreadyReq(requested as boolean);
      setLoadingData(false);
    } catch(e) {
      console.error(e)
    }
  }, [wallets]);
  
  useEffect(() => {
    //if (isOpen) { fetchData(); }
    fetchData()
  }, [fetchData]);

  const request = async () => {
    setRequesting(true)
    try {
      const provider = await wallet.getEthereumProvider();
      const client = createWalletClient({ chain: getChain(), transport: custom(provider) });
      const [account] = await client.getAddresses();
      const requestTx = await client.writeContract({
        address: faucetAddress, abi: FaucetABI, functionName: 'requestTokens',
        args: [],
        account, 
        chain: getChain(),
      });
      await publicClient.waitForTransactionReceipt({ hash: requestTx });
      setAlreadyReq(true)
    } catch(e) {
      console.error(e)
    } finally {
      setRequesting(false)
    }
  }
  return (
    <>
      {requesting ?
          <div className="mg-stat" style={{ marginTop: '1.5rem' }}>
            <span className="mg-stat__label">Requesting OPIN</span>
          </div>
          :
          loadingData ?
            <div className="mg-stat" style={{ marginTop: '1.5rem' }}>
              <span className="mg-stat__label">Loading data</span>
            </div>
          :
          alreadyReq ?
            <div className="mg-stat" style={{ marginTop: '1.5rem' }}>
              <span className="mg-stat__label">You have already requested OPIN</span>
            </div>
            :
          <button
            className="w-full"
            onClick={request}
          >
            Get OPIN
          </button>
      }
    </>
  )
}