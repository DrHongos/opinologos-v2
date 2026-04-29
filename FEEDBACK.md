Feedback over the usage of uniswap-ai.

To create this project i used the plugin of uniswap-ai.
```/plugin marketplace add uniswap/uniswap-ai```

-**first time using it**
-**i am also pretty new with claude-code (1 month in use)**

i cloned an old project of mine in the same folder and then request claude-code
``` build a custom curve hook for conditional tokens. use @../fpmm_using_uniswap/ as a reference. ask me questions if required. try to be extensive but keep security first. build tests. ```
it asked a few questions and then built the hook.
Initial check was pretty good, had to correct a few details very project oriented (this protocol has very specific buy/sell functions and limitations like buys are always **exactIn** while sells are **exactOut**).
Wrote the basic tests (again, based on the old repo). All passed with almost no iterations.
so, after all 9/10. I was amazed.


## Deploy the hook
No need of human supervision, claude+plugin know how to create a script that finds the correct salt to flag our needed address. 10/10


## Connecting the frontend
Here was the tricky part, i **did not installed any other plugin** (and now i supposed the universal-resolver would have been good), but it took a lot to claude to connect the frontend with the PoolManager. I am not sure why but it looped several times requesting permissions to read uniswap module documentation about the universal resolver. In the end, i've got a defficient prototype of connection, in some cases with the allowance requests and others not, in some cases the allowance request was not checked beforehand (having to approve everytime i wanted to transact). Some iterations later it was all connected. Its worth mentioning that buy & sell mechanisms are different on the hook (one requires permit2 while the other setOperator (on hook) is needed).

## TODO: use uniswap-viem to operate declareindependence.eth MCP
